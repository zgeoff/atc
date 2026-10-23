import { mkdir } from 'node:fs/promises';
import { readCleanEnv } from '@atc/config';
import { systemClock, waitUntil } from '@atc/core';
import type { Clock } from '@atc/core';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { spawn } from 'bun-pty';
import type { SessionScopes } from './create-session-scopes';

// `clock` is the clock a harness's exit is waited on. `scopes` are the scopes
// harnesses start in, or null when they start as the daemon's plain children.
export function createLocalPTYProvider(
  clock: Clock = systemClock,
  scopes: SessionScopes | null = null,
): ExecutionProvider {
  const capabilities: ExecutionCapabilities = {
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    headless: true,
    suspend: false,
    destroy: false,
  };

  return {
    kind: 'local-pty',

    remote: false,

    capabilities,

    // The daemon's own machine is always ready.
    prepareHost: (): Promise<void> => Promise.resolve(),

    // The daemon's machine keeps no process the daemon lets go of, so a detach
    // ends the harness as a kill does. With no credential broker here, a harness
    // that requires one never starts.
    spawnHarness: (spec: HarnessSpec): HarnessHandle => {
      if (spec.requireBroker === true) {
        throw new DaemonError(
          'auth_target_unsupported',
          "the daemon's own machine has no credential broker to start the harness behind",
          { provider: 'local-pty' },
        );
      }

      const env = buildPTYEnv(spec);
      const bin = resolveHarnessBin(spec.bin, env, spec.cwd);

      const command = scopes?.buildCommand(spec.session, [bin, ...spec.args]) ?? {
        file: bin,
        args: [...spec.args],
      };

      // bun-pty sets TERM from `name` over the map's TERM, so the harness keeps
      // the TERM the map holds only when `name` is left out.
      const pty = spawn(command.file, command.args, {
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env,
      });

      const subscriptions = new Set<{ readonly dispose: () => void }>();

      return {
        pid: pty.pid,
        onData: (listener) => {
          const subscription = pty.onData(listener);

          subscriptions.add(subscription);

          return subscription;
        },
        onExit: (listener) => {
          const subscription = pty.onExit(listener);

          subscriptions.add(subscription);

          return subscription;
        },
        write: (data) => {
          pty.write(data);
        },
        resize: (cols, rows) => {
          pty.resize(cols, rows);
        },
        kill: () => {
          pty.kill();
        },

        // A process already gone has nothing left to end.
        killForced: () => {
          try {
            process.kill(pty.pid, 'SIGKILL');
          } catch (error) {
            if (!isMissingProcessError(error)) {
              throw error;
            }
          }
        },

        // bun-pty's kill reports an exit at once whether the process ended or not, so
        // the exit is read from the pid, which stops answering a signal once the
        // library reaps its child.
        waitForExit: (timeoutMs) =>
          waitUntil(() => !isProcessRunning(pty.pid), {
            clock,
            intervalMs: 20,
            deadlineMs: clock.now() + timeoutMs,
          }),
        detach: () => {
          for (const subscription of subscriptions) {
            subscription.dispose();
          }

          pty.kill();
        },
      };
    },

    // Options the host passes to GNU tar through `TAR_OPTIONS` are ignored,
    // since one could leave tracked files out of the unpacked checkout.
    transferArchive: async (archive: Uint8Array, directory: string): Promise<void> => {
      await mkdir(directory, { recursive: true });

      const { TAR_OPTIONS: _ignored, ...env } = process.env;

      const result = await runCommandWithInput(
        ['tar', '-x', '-f', '-', '-C', directory],
        directory,
        archive,
        env,
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `tar exited ${result.exitCode} unpacking into ${directory}: ${result.stderr}`,
        );
      }
    },

    runCommand: (spec: CommandSpec): Promise<CommandResult> =>
      runCommandWithInput(spec.argv, spec.cwd, null),

    suspendHost: (host: string): Promise<void> =>
      Promise.reject(new Error(`the local-pty provider cannot suspend host ${host}`)),

    destroyHost: (host: string): Promise<void> =>
      Promise.reject(new Error(`the local-pty provider cannot destroy host ${host}`)),

    // The harnesses have ended or been told to end, so a process one left
    // behind is all a scope still holds. The returned promise settles once
    // the service manager has queued each stop.
    dispose: async (): Promise<void> => {
      await scopes?.stop();
    },
  };
}

const USABLE_TERM = 'xterm-256color';

// A pseudo-terminal always has a terminal on its far side, so a harness never
// starts with an empty or dumb TERM, which leaves an agent CLI drawing with no
// colour.
function buildPTYEnv(spec: HarnessSpec): Record<string, string> {
  const env = readCleanEnv(spec.env, spec.withheldEnv);
  const term = env['TERM'];

  return {
    ...env,
    TERM: term === undefined || term === '' || term === 'dumb' ? USABLE_TERM : term,
  };
}

// The PTY library looks a bare program up on the daemon's own PATH when the
// map holds none, so the program is found on the map's PATH alone before the
// harness starts.
function resolveHarnessBin(
  bin: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): string {
  const resolved = Bun.which(bin, { PATH: env['PATH'] ?? '', cwd });

  if (resolved === null) {
    throw new Error(`PTY spawn failed: ${bin} is not a program the harness can start`);
  }

  return resolved;
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

// A process another user owns still runs, so only a missing process counts
// as gone.
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

async function runCommandWithInput(
  argv: readonly string[],
  cwd: string,

  input: Uint8Array | null,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...argv], {
    cwd,
    ...(env === undefined ? {} : { env: { ...env } }),
    stdin: input ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}
