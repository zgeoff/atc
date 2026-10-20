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
import { buildHarnessArgv } from './build-harness-argv';
import { readNativeEnvKeys } from './read-native-env-keys';
import type { SessionScopes } from './session-scopes';

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

  // The clock a harness's exit is waited on.
  private readonly clock: Clock;

  // The scopes harnesses start in, or null when they start as the daemon's
  // plain children.
  private readonly scopes: SessionScopes | null;

  constructor(clock: Clock = systemClock, scopes: SessionScopes | null = null) {
    this.clock = clock;
    this.scopes = scopes;
  }

  // The daemon's own machine is always ready.
  readonly prepareHost = (): Promise<void> => Promise.resolve();

  // The daemon's machine keeps no process the daemon lets go of, so a detach
  // ends the harness as a kill does. With no credential broker here, a harness
  // that requires one never starts.
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

    const argv = [
      ENV_BIN,
      ...buildHarnessArgv({ unset, env, platform: process.platform, bin, args: spec.args }),
    ];

    const command = this.scopes?.buildCommand(spec.session, argv) ?? {
      file: ENV_BIN,
      args: argv.slice(1),
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
          clock: this.clock,
          intervalMs: 20,
          deadlineMs: this.clock.now() + timeoutMs,
        }),
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
  readonly transferArchive = async (archive: Uint8Array, directory: string): Promise<void> => {
    await mkdir(directory, { recursive: true });

    const { TAR_OPTIONS: _ignored, ...env } = process.env;

    const result = await this.runCommandWithInput(
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
  };

  readonly runCommand = (spec: CommandSpec): Promise<CommandResult> =>
    this.runCommandWithInput(spec.argv, spec.cwd, null);

  readonly suspendHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the local-pty provider cannot suspend host ${host}`));

  readonly destroyHost = (host: string): Promise<void> =>
    Promise.reject(new Error(`the local-pty provider cannot destroy host ${host}`));

  // The harnesses have ended or been told to end, so a process one left
  // behind is all a scope still holds. The returned promise settles once
  // the service manager has queued each stop.
  readonly dispose = async (): Promise<void> => {
    await this.scopes?.stop();
  };

  private async runCommandWithInput(
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

// The PTY library lays the map over the environment the daemon started with,
// so the harness starts behind env, which unsets every name the map leaves out
// and replaces itself with the harness.
const ENV_BIN = '/usr/bin/env';

// The program is found on the map's PATH before the harness starts, so a
// missing program fails the spawn as the PTY library fails it, instead of
// starting `env` only to exit.
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
