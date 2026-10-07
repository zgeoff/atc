import { mkdir } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import { DaemonError } from '../protocol/daemon-error';
import { collectCleanEnv } from '../shared/collect-clean-env';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessHandle,
  HarnessSpec,
} from './execution-provider';
import { readNativeEnvKeys } from './read-native-env-keys';

/**
 * The `local-pty` provider: harnesses run as child processes of the daemon
 * on a `bun-pty` pseudo-terminal, and files and commands touch the daemon's
 * own host. The host is the daemon's machine, so there is nothing to
 * suspend or destroy.
 */
export class LocalPTYProvider implements ExecutionProvider {
  readonly kind = 'local-pty';

  readonly remote = false;

  readonly capabilities: ExecutionCapabilities = {
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

  // The daemon's own machine is always ready.
  readonly prepareHost = (): Promise<void> => Promise.resolve();

  // The daemon's machine keeps no process the daemon lets go of, so a
  // detach ends the harness as a kill does, after dropping every listener.
  // It has no credential broker, so a harness that requires one never
  // starts here.
  readonly spawnHarness = (spec: HarnessSpec): HarnessHandle => {
    if (spec.requireBroker === true) {
      throw new DaemonError(
        'auth_target_unsupported',
        "the daemon's own machine has no credential broker to start the harness behind",
        { provider: 'local-pty' },
      );
    }

    const env = buildPTYEnv(spec);
    const bin = resolveHarnessBin(spec.bin, env, spec.cwd);
    const unset = buildUnsetNames(env, [...readNativeEnvKeys(), ...Object.keys(process.env)]);

    const pty = spawn(
      ENV_BIN,
      [...unset.flatMap((name) => ['-u', name]), '--', bin, ...spec.args],
      {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env,
      },
    );

    const subscriptions = new Set<{ readonly dispose: () => void }>();

    return {
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

      // bun-pty's kill sends one SIGHUP and reports an exit at once, whether
      // the process ended or not, so the exit is read from the process id
      // instead: the library reaps its child, so the id stops answering a
      // signal once the process is gone.
      waitForExit: async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;

        while (isProcessRunning(pty.pid)) {
          if (Date.now() >= deadline) {
            return false;
          }

          await Bun.sleep(20);
        }

        return true;
      },
      detach: () => {
        for (const subscription of subscriptions) {
          subscription.dispose();
        }

        pty.kill();
      },
    };
  };

  // Options the host passes to GNU tar through `TAR_OPTIONS` are ignored,
  // since one could leave tracked files out of the unpacked checkout.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- archive bytes have no readonly form
  readonly transferArchive = async (archive: Uint8Array, dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });

    const { TAR_OPTIONS: _ignored, ...env } = process.env;

    const result = await this.runCommandWithInput(
      ['tar', '-x', '-f', '-', '-C', dir],
      dir,
      archive,
      env,
    );

    if (result.exitCode !== 0) {
      throw new Error(`tar exited ${result.exitCode} unpacking into ${dir}: ${result.stderr}`);
    }
  };

  readonly runCommand = (spec: CommandSpec): Promise<CommandResult> =>
    this.runCommandWithInput(spec.argv, spec.cwd, null);

  readonly suspendHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the local-pty provider cannot suspend host ${host}`));

  readonly destroyHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the local-pty provider cannot destroy host ${host}`));

  readonly dispose = (): void => {};

  private async runCommandWithInput(
    argv: readonly string[],
    cwd: string,

    // oxlint-disable-next-line prefer-readonly-parameter-types -- input bytes have no readonly form
    input: Uint8Array | null,
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<CommandResult> {
    const proc = Bun.spawn([...argv], {
      cwd,
      ...(env === undefined ? {} : { env: { ...env } }),
      stdin: input ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  }
}

const USABLE_TERM = 'xterm-256color';

// A pseudo-terminal always has a terminal on its far side, so a harness never
// starts with an empty or dumb TERM, which leaves an agent CLI drawing with no
// colour.
function buildPTYEnv(spec: HarnessSpec): Record<string, string> {
  const env = collectCleanEnv(spec.env, spec.withheldEnv);
  const term = env['TERM'];

  return {
    ...env,
    TERM: term === undefined || term === '' || term === 'dumb' ? USABLE_TERM : term,
  };
}

// The PTY library starts its child from the environment the daemon started
// with and lays the map over it, so the harness starts behind `env`, which
// unsets every name the map leaves out before it replaces itself with the
// harness. The pid stays the harness's own, and the argv holds names only.
const ENV_BIN = '/usr/bin/env';

// The program is found on the map's PATH before the harness starts, so a
// missing program fails the spawn as the PTY library fails it, instead of
// starting `env` only to exit. `env` reads a word holding `=` as an
// assignment even after `--`, so such a path never starts.
function resolveHarnessBin(
  bin: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): string {
  const resolved = Bun.which(bin, { PATH: env['PATH'] ?? '', cwd });

  if (resolved === null || resolved.includes('=')) {
    throw new Error(`PTY spawn failed: ${bin} is not a program the harness can start`);
  }

  return resolved;
}

// A name the native environment block cannot hold, such as one with `=`,
// is left alone, since `env` refuses to unset it.
function buildUnsetNames(
  env: Readonly<Record<string, string>>,
  inherited: readonly string[],
): string[] {
  return [...new Set(inherited)].filter(
    (name) => name !== '' && !name.includes('=') && !Object.hasOwn(env, name),
  );
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

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
