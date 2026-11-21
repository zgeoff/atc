import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { killProcessGroup } from '@atc/core/test-utils/kill-process-group';
import { createDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import type { Subprocess } from 'bun';
import { readDaemonRecord } from '../daemon-files/read-daemon-record';
import { buildStderrReportingClient } from './build-stderr-reporting-client';

interface DaemonProcessConfig {
  readonly command: readonly string[];

  readonly home: string;

  readonly env?: Readonly<Record<string, string | undefined>>;

  readonly args?: readonly string[];

  readonly freshState?: boolean;

  readonly writeReport?: (text: string) => void;
}

interface DaemonBoot {
  readonly subprocess: Subprocess;
  readonly stderrPath: string;
}

export function startDaemonProcess(config: Readonly<DaemonProcessConfig>) {
  const daemonEnv = {
    ...process.env,
    HOME: config.home,
    XDG_RUNTIME_DIR: config.home,
    PATH: '/usr/sbin:/usr/bin:/bin',
    ...config.env,
  };

  const paths = resolvePaths(daemonEnv);
  const stderrDir = mkdtempSync(join(config.home, 'daemon-stderr-'));

  registerTestCleanup(() => {
    rmSync(stderrDir, { recursive: true, force: true });
  });

  const clients = new Set<DaemonClient>();

  let boots = 0;
  const groups: number[] = [];
  let stopped = false;

  const boot = (): DaemonBoot => {
    boots++;

    const stderrPath = join(stderrDir, `boot-${boots}.stderr`);

    if (config.freshState !== true && !existsSync(paths.dbFile)) {
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      createMigratedStateDB(paths.dbFile);
    }

    const subprocess = Bun.spawn([...config.command, 'daemon', ...(config.args ?? [])], {
      env: Object.fromEntries(
        Object.entries(daemonEnv).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdout: 'ignore',
      stderr: Bun.file(stderrPath),

      detached: true,
    });

    groups.push(subprocess.pid);

    return { subprocess, stderrPath };
  };

  let current = boot();

  const stop = registerTestCleanup(async () => {
    stopped = true;

    for (const client of clients) {
      client.stop();
    }

    for (const group of groups) {
      killProcessGroup(group);
    }

    await current.subprocess.exited;

    const recorded = readDaemonRecord(paths.daemonRecordFile);

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

  const openTrackedClient = async (isAbandoned: () => boolean) => {
    // the client connects at its hello, so a probe finds out that the daemon accepts first
    const probe = connect(paths.daemonSocketPath);

    try {
      await once(probe, 'connect');
    } finally {
      probe.destroy();
    }

    const client = createDaemonClient(paths.daemonSocketPath);

    if (stopped || isAbandoned()) {
      client.stop();
      throw new Error('the wait for the daemon ended before this client opened');
    }

    clients.add(client);

    return buildStderrReportingClient(
      client,
      readStderr,
      config.writeReport ??
        ((text) => {
          process.stderr.write(text);
        }),
    );
  };

  const openClient = async (): Promise<DaemonClient> => {
    const watched = current.subprocess;
    let settled = false;
    const isSettled = () => settled;
    const isWatchedExited = () => watched.exitCode !== null || watched.signalCode !== null;
    let polled: Promise<DaemonClient> | null = null;

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
    paths,
    socketPath: paths.daemonSocketPath,
    reporterSocketPath: paths.socketPath,
    stateDir: paths.stateDir,
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
