import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { DaemonClient } from '../client/daemon-client';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { registerTestCleanup } from './register-test-cleanup';
import { waitFor } from './wait-for';

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
}

/**
 * One boot of the daemon: its process and the file its stderr goes to.
 */
interface DaemonBoot {
  readonly proc: Subprocess;
  readonly stderrPath: string;
}

/**
 * Starts `atc daemon` as its own process on a home, with the test's
 * environment, HOME and XDG_RUNTIME_DIR at the home, and a PATH of the system
 * directories alone unless the config's variables set another. It returns at
 * once; `openClient` waits up to 15 seconds for the socket and connects,
 * sending no handshake, and fails at once with the daemon's stderr when the
 * daemon exits before it listens. `restart` stops the daemon with the given
 * signal, waits for it to exit, and starts another on the same home with the
 * same config, and throws once the daemon is stopped. `readStderr` reads
 * what the current boot printed, from a file in `stderrDir`, a directory
 * under the home that no other daemon on the home writes. `stop` closes
 * every client it opened, kills the daemon and waits for it to exit, then
 * kills the daemon the home's state directory records, which a restart the
 * test asked atc for may have started. That stop runs once the current test
 * finishes, so it must run inside a test; calling `stop` sooner runs it
 * then, and a second stop does nothing. `stderrDir` is removed once the
 * current test finishes, after the stop, so a test can still read the
 * stderr after an early stop.
 */
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

    const proc = Bun.spawn([...config.command, 'daemon', ...(config.args ?? [])], {
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

    return { proc, stderrPath };
  };

  let current = boot();

  const stop = registerTestCleanup(async () => {
    stopped = true;

    for (const client of clients) {
      client.stop();
    }

    current.proc.kill('SIGKILL');

    await current.proc.exited;

    const recorded = findDaemonRecord(join(stateDir, 'daemon.json'));

    if (recorded !== null && recorded.pid !== current.proc.pid) {
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
    const client = await DaemonClient.open(socketPath);

    if (stopped || isAbandoned()) {
      client.stop();
      throw new Error('the wait for the daemon ended before this client opened');
    }

    clients.add(client);

    return client;
  };

  const openClient = async (): Promise<DaemonClient> => {
    const watched = current.proc;
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

    // Polls the socket while the daemon runs. Once the daemon exits, it dials
    // no more and leaves the connect to the wait after the exit. Once the
    // other wait settles or the daemon stops, each attempt resolves empty,
    // which ends the polling.
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
    get proc(): Subprocess {
      return current.proc;
    },
    readStderr,
    openClient,
    async restart(signal: NodeJS.Signals): Promise<void> {
      if (stopped) {
        throw new Error('a stopped daemon process cannot restart');
      }

      current.proc.kill(signal);

      await current.proc.exited;

      current = boot();
    },
    stop,
  };
}
