import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB, registerTestCleanup, waitFor } from '@atc/test-utils';
import type { Subprocess } from 'bun';
import { readDaemonRecord } from '../read-daemon-record';

interface DaemonProcessConfig {
  // The command atc runs as, such as the source entry under bun or a
  // compiled binary.
  readonly command: readonly string[];

  // HOME and XDG_RUNTIME_DIR of the daemon, so its config, state, and
  // sockets all sit under this directory.
  readonly home: string;

  // Variables laid over the inherited environment and the default PATH;
  // `undefined` removes one.
  readonly env?: Readonly<Record<string, string | undefined>>;

  // Arguments after `atc daemon`.
  readonly args?: readonly string[];

  readonly freshState?: boolean;
}

interface DaemonBoot {
  readonly subprocess: Subprocess;
  readonly stderrPath: string;
}

export function startDaemonProcess(config: Readonly<DaemonProcessConfig>) {
  const socketPath = join(config.home, 'atc-daemon.sock');
  const stateDir = join(config.home, '.local', 'state', 'atc');

  // A directory of this helper's own under the home, so two daemons started
  // on one home never write into one stderr file.
  const stderrDir = mkdtempSync(join(config.home, 'daemon-stderr-'));

  // Registered before the stop, so it runs after the daemon is gone.
  registerTestCleanup(() => {
    rmSync(stderrDir, { recursive: true, force: true });
  });

  const clients = new Set<DaemonClient>();

  let boots = 0;
  let stopped = false;

  const boot = (): DaemonBoot => {
    boots++;

    const stderrPath = join(stderrDir, `boot-${boots}.stderr`);
    const bootStateDir = join(config.env?.['HOME'] ?? config.home, '.local', 'state', 'atc');

    if (config.freshState !== true && !existsSync(join(bootStateDir, 'atc.db'))) {
      mkdirSync(bootStateDir, { recursive: true, mode: 0o700 });
      createMigratedStateDB(join(bootStateDir, 'atc.db'));
    }

    const subprocess = Bun.spawn([...config.command, 'daemon', ...(config.args ?? [])], {
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          HOME: config.home,
          XDG_RUNTIME_DIR: config.home,
          PATH: '/usr/sbin:/usr/bin:/bin',
          ...config.env,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      stdout: 'ignore',
      stderr: Bun.file(stderrPath),
    });

    return { subprocess, stderrPath };
  };

  let current = boot();

  const stop = registerTestCleanup(async () => {
    stopped = true;

    for (const client of clients) {
      client.stop();
    }

    current.subprocess.kill('SIGKILL');

    await current.subprocess.exited;

    const recorded = readDaemonRecord(join(stateDir, 'daemon.json'));

    if (recorded !== null && recorded.pid !== current.subprocess.pid) {
      try {
        process.kill(recorded.pid, 'SIGKILL');
      } catch {}
    }
  });

  const readStderr = () => {
    try {
      return readFileSync(current.stderrPath, 'utf8');
    } catch {
      return '';
    }
  };

  // A client that opens after the wait for it ended, or after the stop,
  // closes at once, so nothing outlives the daemon it reached.
  const openTrackedClient = async (isAbandoned: () => boolean) => {
    const client = await openDaemonClient(socketPath);

    if (stopped || isAbandoned()) {
      client.stop();
      throw new Error('the wait for the daemon ended before this client opened');
    }

    clients.add(client);

    return client;
  };

  const openClient = async (): Promise<DaemonClient> => {
    const watched = current.subprocess;
    let settled = false;
    const isSettled = () => settled;
    const isWatchedExited = () => watched.exitCode !== null || watched.signalCode !== null;

    // The poll's latest connect, so the wait after an exit can reuse one
    // that was still in flight instead of dialing a second time.
    let polled: Promise<DaemonClient> | null = null;

    // A daemon that has exited either refused to start or handed its socket
    // to a replacement, so one more connect tells the two apart.
    const openAfterExit = async () => {
      await watched.exited;

      if (settled || stopped) {
        return null;
      }

      const inFlight = await polled?.catch(() => null);

      if (inFlight !== undefined && inFlight !== null) {
        return inFlight;
      }

      try {
        return await openTrackedClient(isSettled);
      } catch {
        throw new Error(
          `the daemon exited (${String(watched.exitCode ?? watched.signalCode)}) before it listened:\n${readStderr()}`,
        );
      }
    };

    // polls only while the daemon runs, leaving the connect after an exit to
    // the other wait; once either wait settles or the daemon stops, each attempt
    // resolves empty, which ends the polling.
    const openWhenListening = () =>
      waitFor(
        () => {
          if (settled || stopped) {
            return null;
          }

          if (isWatchedExited()) {
            throw new Error('the daemon exited');
          }

          polled = openTrackedClient(isSettled);

          return polled;
        },
        { timeoutMs: 15_000, intervalMs: 50 },
      );

    const hasExited = isWatchedExited();

    try {
      const client = await (hasExited
        ? openAfterExit()
        : Promise.race([openWhenListening(), openAfterExit()]));

      if (client === null) {
        throw new Error('the wait for the daemon settled without a client');
      }

      return client;
    } finally {
      settled = true;
    }
  };

  return {
    home: config.home,
    socketPath,
    reporterSocketPath: join(config.home, 'atc.sock'),
    stateDir,
    stderrDir,
    get subprocess(): Subprocess {
      return current.subprocess;
    },
    readStderr,
    openClient,
    async restart(signal: NodeJS.Signals): Promise<void> {
      if (stopped) {
        throw new Error('a stopped daemon process cannot restart');
      }

      current.subprocess.kill(signal);

      await current.subprocess.exited;

      current = boot();
    },
    stop,
  };
}
