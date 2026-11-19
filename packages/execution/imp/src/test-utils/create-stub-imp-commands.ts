import { posix } from 'node:path';
import type { Subprocess } from 'bun';
import { buildImpdRefusal } from '../impd/build-impd-refusal';
import type { ImpCommand, ImpCommandResult } from '../port/imp-port';
import { buildNotFound } from './build-not-found';
import type { StubImp } from './stub-imp';

export interface StubCommandHold {
  readonly entered: Promise<string>;
  readonly stop: () => void;
}

export interface StubImpCommands {
  // impd gives every guest process this directory as HOME and starts a command with no
  // working directory in it; null keeps the test's own working directory and environment.
  homeDir: string | null;

  readonly runCommand: (name: string, command: ImpCommand) => Promise<ImpCommandResult>;

  // impd starts a relative directory from the root, where its agent runs. A
  // path goes over unfolded, so a `..` after a symlink leaves the link's target,
  // as the kernel walks it.
  readonly resolveGuestCwd: (cwd: string | undefined) => string | undefined;

  readonly setHomeDir: (directory: string) => void;
  readonly setGuestPath: (path: string) => void;
  readonly startCommandHold: (match: string) => StubCommandHold;

  readonly countHeldCommands: () => number;

  readonly stopCommandHold: () => void;

  readonly setCommandFailure: (match: string | null) => void;

  // The kill signals each command's whole process group, not just the command, so a child
  // left holding the command's output ends too.
  readonly kill: () => readonly Subprocess[];
}

// The PATH every stub process runs with: a guest's own, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The exit code of a guest command killed by SIGKILL.
const KILLED_CODE = 137;

interface StubImpCommandsOptions {
  readonly calls: string[];
  readonly imps: ReadonlyMap<string, StubImp>;
  readonly report: (line: string) => void;
}

export function createStubImpCommands(deps: StubImpCommandsOptions): StubImpCommands {
  let guestPath = GUEST_PATH;

  let commandHold: {
    readonly match: string;
    readonly entered: PromiseWithResolvers<string>;
    readonly done: PromiseWithResolvers<void>;
  } | null = null;

  let heldCommands = 0;

  const commands = new Map<Subprocess, { readonly line: string; readonly pending: Set<string> }>();

  let stopped = false;
  const killed = Promise.withResolvers<null>();
  let commandFailure: string | null = null;
  const calls = deps.calls;
  const imps = deps.imps;
  const report = deps.report;

  const resolveGuestCwd = (cwd: string | undefined): string | undefined => {
    if (cwd === undefined) {
      return self.homeDir ?? undefined;
    }

    return posix.isAbsolute(cwd) ? cwd : `/${cwd}`;
  };

  const stopCommandHold = (): void => {
    const hold = commandHold;

    commandHold = null;
    hold?.done.resolve();
  };

  const self: StubImpCommands = {
    homeDir: null,

    runCommand: async (name, command) => {
      calls.push(`exec.run ${name} ${command.argv.join(' ')}`);

      const imp = imps.get(name);

      if (imp === undefined) {
        throw buildNotFound('exec.ticket', name);
      }

      if (imp.state !== 'running') {
        throw buildImpdRefusal(
          'exec.ticket',
          {
            code: 'INVALID_STATE',
            data: {
              state: imp.state,
              allowed: ['running'],
            },
          },
          `imp ${name} is ${imp.state}`,
        );
      }

      const line = command.argv.join(' ');
      const hold = commandHold;

      if (hold !== null && line.includes(hold.match)) {
        hold.entered.resolve(line);

        heldCommands += 1;

        await hold.done.promise;

        heldCommands -= 1;
      }

      // A command that gets past the hold after a stop, held or not, ends as a
      // killed one does, so no process outlives the stop.
      if (stopped) {
        return { code: KILLED_CODE, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
      }

      if (commandFailure !== null && line.includes(commandFailure)) {
        const encoder = new TextEncoder();

        return {
          code: 1,
          stdout: new Uint8Array(0),
          stderr: encoder.encode('the command failed\n'),
        };
      }

      const cwd = resolveGuestCwd(command.cwd);

      const subprocess = Bun.spawn([...command.argv], {
        ...(cwd === undefined ? {} : { cwd }),
        env: { PATH: guestPath, ...(self.homeDir === null ? {} : { HOME: self.homeDir }) },
        stdin: command.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });

      const pending = new Set(['stdout', 'stderr', 'exit']);

      commands.set(subprocess, { line, pending });

      const settled = await Promise.race([
        Promise.all([
          new Response(subprocess.stdout).bytes().finally(() => {
            pending.delete('stdout');
          }),
          new Response(subprocess.stderr).bytes().finally(() => {
            pending.delete('stderr');
          }),
          subprocess.exited.finally(() => {
            pending.delete('exit');
          }),
        ]),
        killed.promise,
      ]);

      commands.delete(subprocess);

      // Don't wait for output after a kill: Bun can miss the close of a pipe whose last holder
      // the kill ended, and the read of that pipe then never settles.
      if (settled === null) {
        return { code: KILLED_CODE, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
      }

      const [stdout, stderr, code] = settled;

      return { code, stdout, stderr };
    },

    resolveGuestCwd,

    setHomeDir: (directory) => {
      self.homeDir = directory;
    },

    setGuestPath: (path) => {
      guestPath = path;
    },

    startCommandHold: (match) => {
      if (commandHold !== null) {
        throw new Error(`a hold on ${commandHold.match} is still active`);
      }

      const hold = {
        match,
        entered: Promise.withResolvers<string>(),
        done: Promise.withResolvers<void>(),
      };

      commandHold = hold;

      const stop = () => {
        if (commandHold === hold) {
          commandHold = null;
        }

        hold.done.resolve();
      };

      return { entered: hold.entered.promise, stop };
    },

    countHeldCommands: () => heldCommands,

    stopCommandHold,

    setCommandFailure: (match) => {
      commandFailure = match;
    },

    kill: () => {
      stopped = true;

      stopCommandHold();

      const running = [...commands.keys()];

      // A command that ended in part, its exit seen but its output still open
      // or the reverse, is a wait that may never end. One with nothing seen
      // yet is a command the stop cuts short, which is ordinary.
      for (const command of commands.values()) {
        if (command.pending.size === 0 || command.pending.size === 3) {
          continue;
        }

        report(
          `the stub imp port stopped while a guest command still ran: ${command.line}; it waited for ${[...command.pending].join(', ')}`,
        );
      }

      for (const command of running) {
        tryKillGroup(command.pid);
      }

      killed.resolve(null);

      return running;
    },
  };

  return self;
}

// A guest command leads a process group of its own, so the kill also ends
// a child it left holding its output; a group already empty has nothing
// left to kill.
function tryKillGroup(leader: number): void {
  try {
    process.kill(-leader, 'SIGKILL');
  } catch {}
}
