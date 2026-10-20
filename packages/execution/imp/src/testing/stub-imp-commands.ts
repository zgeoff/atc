import { posix } from 'node:path';
import type { Subprocess } from 'bun';
import { buildImpdRefusal } from '../build-impd-refusal';
import type { ImpCommand, ImpCommandResult } from '../imp-port';
import { buildNotFound } from './build-not-found';
import type { StubImp } from './stub-imp';

// The PATH every stub process runs with: a guest's own, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The exit code of a guest command killed by SIGKILL.
const KILLED_CODE = 137;

// A hold on the commands whose argv holds its text: entered resolves with
// the argv of the first command it holds, and stop lets every command it
// holds run.
export interface StubCommandHold {
  readonly entered: Promise<string>;
  readonly stop: () => void;
}

interface StubImpCommandsOptions {
  readonly calls: string[];
  readonly imps: ReadonlyMap<string, StubImp>;
  readonly report: (line: string) => void;
}

// The guest commands that run inside the imps, the guest environment they
// and the sessions start in, and the holds and failures a test puts on them.
export class StubImpCommands {
  // The guest's home inside every imp: a missing working directory
  // resolves to it and every process takes it as HOME, as impd gives one;
  // null for the test's own working directory and environment.
  homeDir: string | null = null;

  private guestPath = GUEST_PATH;

  // Commands whose argv holds this text wait for the hold to stop, while
  // one is held.
  private commandHold: {
    readonly match: string;
    readonly entered: PromiseWithResolvers<string>;
    readonly done: PromiseWithResolvers<void>;
  } | null = null;

  // How many commands wait on a command hold.
  private heldCommands = 0;

  // The guest commands running now, which a stop kills, each with its argv
  // and the parts of its end not yet seen: stdout, stderr, and exit.
  private readonly commands = new Map<
    Subprocess,
    { readonly line: string; readonly pending: Set<string> }
  >();

  // Set once the stand-in stops, so a command a hold released never runs.
  private stopped = false;

  // Settles once a stop has killed every guest command, so a run still
  // waiting on a killed command's output stops waiting.
  private readonly killed = Promise.withResolvers<null>();

  // Commands whose argv holds this text exit 1 without running, or null.
  private commandFailure: string | null = null;

  private readonly calls: string[];

  private readonly imps: ReadonlyMap<string, StubImp>;

  // Takes one line per guest command a stop finds still running.
  private readonly report: (line: string) => void;

  constructor(deps: StubImpCommandsOptions) {
    this.calls = deps.calls;
    this.imps = deps.imps;
    this.report = deps.report;
  }

  async runCommand(name: string, command: ImpCommand): Promise<ImpCommandResult> {
    this.calls.push(`exec.run ${name} ${command.argv.join(' ')}`);

    const imp = this.imps.get(name);

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
    const hold = this.commandHold;

    if (hold !== null && line.includes(hold.match)) {
      hold.entered.resolve(line);

      this.heldCommands += 1;

      await hold.done.promise;

      this.heldCommands -= 1;
    }

    // A command that gets past the hold after a stop, held or not, ends as a
    // killed one does, so no process outlives the stop.
    if (this.stopped) {
      return { code: KILLED_CODE, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
    }

    if (this.commandFailure !== null && line.includes(this.commandFailure)) {
      const encoder = new TextEncoder();

      return { code: 1, stdout: new Uint8Array(0), stderr: encoder.encode('the command failed\n') };
    }

    const cwd = this.resolveGuestCwd(command.cwd);

    const subprocess = Bun.spawn([...command.argv], {
      ...(cwd === undefined ? {} : { cwd }),
      env: { PATH: this.guestPath, ...(this.homeDir === null ? {} : { HOME: this.homeDir }) },
      stdin: command.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });

    const pending = new Set(['stdout', 'stderr', 'exit']);

    this.commands.set(subprocess, { line, pending });

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
      this.killed.promise,
    ]);

    this.commands.delete(subprocess);

    // A run the stop cut short ends as a killed one does, without waiting
    // for output: the runtime can miss the close of a pipe whose last
    // holder a kill ended, and then that output never ends.
    if (settled === null) {
      return { code: KILLED_CODE, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
    }

    const [stdout, stderr, code] = settled;

    return { code, stdout, stderr };
  }

  // impd starts a relative directory from the root, where its agent runs. A
  // path goes over unfolded, so a `..` after a symlink leaves the link's target,
  // as the kernel walks it.
  resolveGuestCwd(cwd: string | undefined): string | undefined {
    if (cwd === undefined) {
      return this.homeDir ?? undefined;
    }

    return posix.isAbsolute(cwd) ? cwd : `/${cwd}`;
  }

  setHomeDir(directory: string): void {
    this.homeDir = directory;
  }

  setGuestPath(path: string): void {
    this.guestPath = path;
  }

  startCommandHold(match: string): StubCommandHold {
    if (this.commandHold !== null) {
      throw new Error(`a hold on ${this.commandHold.match} is still active`);
    }

    const hold = {
      match,
      entered: Promise.withResolvers<string>(),
      done: Promise.withResolvers<void>(),
    };

    this.commandHold = hold;

    const stop = () => {
      if (this.commandHold === hold) {
        this.commandHold = null;
      }

      hold.done.resolve();
    };

    return { entered: hold.entered.promise, stop };
  }

  // How many commands wait for their command hold to stop.
  countHeldCommands(): number {
    return this.heldCommands;
  }

  // Lets every command the active hold holds run, and the next at once.
  stopCommandHold(): void {
    const hold = this.commandHold;

    this.commandHold = null;
    hold?.done.resolve();
  }

  setCommandFailure(match: string | null): void {
    this.commandFailure = match;
  }

  // Kills every guest command still running, and returns them so the stop
  // can wait for their exits. The kill takes each command's whole process
  // group, so a child left holding the command's output ends too.
  kill(): readonly Subprocess[] {
    this.stopped = true;

    this.stopCommandHold();

    const commands = [...this.commands.keys()];

    // A command that ended in part, its exit seen but its output still open
    // or the reverse, is a wait that may never end. One with nothing seen
    // yet is a command the stop cuts short, which is ordinary.
    for (const running of this.commands.values()) {
      if (running.pending.size === 0 || running.pending.size === 3) {
        continue;
      }

      this.report(
        `the stub imp port stopped while a guest command still ran: ${running.line}; it waited for ${[...running.pending].join(', ')}`,
      );
    }

    for (const command of commands) {
      tryKillGroup(command.pid);
    }

    this.killed.resolve(null);

    return commands;
  }
}

// A guest command leads a process group of its own, so the kill also ends
// a child it left holding its output; a group already empty has nothing
// left to kill.
function tryKillGroup(leader: number): void {
  try {
    process.kill(-leader, 'SIGKILL');
  } catch {}
}
