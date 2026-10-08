import type { ChildProcess } from 'node:child_process';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { parseDaemonFeatures } from '../protocol/parse-daemon-features';
import { PROTOCOL_V } from '../protocol/protocol';
import type { AgentID } from '../shared/agent-id';
import { daemonPidFile, daemonRecordFile, daemonSocketPath } from '../shared/config';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { findPidFilePID } from '../shared/find-pid-file-pid';
import { getBuild } from '../shared/get-build';
import { isProcessAlive } from '../shared/is-process-alive';
import { makeSingleFlight } from '../shared/make-single-flight';
import { spawnATCDetached } from '../shared/spawn-atc-detached';
import { systemClock } from '../shared/system-clock';
import type { Clock } from '../shared/system-clock';
import { toAgentID } from '../shared/to-agent-id';
import { DaemonClient } from './daemon-client';
import { formatProtocolMismatch } from './format-protocol-mismatch';
import type { ProtocolMismatch } from './format-protocol-mismatch';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';

export interface DaemonBoot {
  readonly client: DaemonClient;
  readonly stale: boolean;
  readonly lastUsedAgent: AgentID;

  // What the daemon announced it serves; an older daemon announces less.
  readonly features: ReadonlySet<DaemonFeature>;

  // The socket the client reached, which differs from the computed one when
  // the daemon was found through its record in the state directory.
  readonly socketPath: string;
}

/**
 * The files that locate a running daemon: the socket this environment
 * computes, the record the daemon writes in its state directory, and its
 * pid file.
 */
export interface DaemonPaths {
  readonly socketPath: string;
  readonly recordFile: string;
  readonly pidFile: string;
}

export interface DaemonBootOptions {
  // Called when the daemon speaks another protocol version. Resolving true
  // stops that daemon and boots one from this build, which ends every
  // session it hosts; without the callback, or resolving false, the boot
  // rejects and the daemon keeps running.
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => Promise<boolean>;

  // When set, the boot never starts a daemon: it waits this many
  // milliseconds for one to answer, then rejects. A caller that a service
  // manager starts beside a managed daemon sets it, so the two never race
  // for the state directory.
  readonly waitForDaemonMs?: number;

  // Called once per boot, when a waiting boot first finds no daemon and
  // starts to wait instead of starting one; a retry after a protocol
  // mismatch that waits again does not call it a second time.
  readonly onWaitForDaemon?: () => void;

  // The time and the timers a waiting boot reads for its deadline and its
  // polls; the wall clock when absent.
  readonly clock?: Clock;

  // Where the boot looks for a running daemon and its pid; this process's
  // own paths when absent. `atc daemon` takes no paths of its own, only the
  // environment's, so a boot given paths never starts a daemon: when none
  // answers there, it rejects at once.
  readonly paths?: DaemonPaths;
}

const PROCESS_PATHS: DaemonPaths = {
  socketPath: daemonSocketPath,
  recordFile: daemonRecordFile,
  pidFile: daemonPidFile,
};

/**
 * Opens a handshaken client to the daemon, booting the daemon first when
 * neither the computed socket nor the one in the daemon's record answers,
 * or waiting for one to answer when the caller set `waitForDaemonMs`.
 * Overlapping calls in one process share a single boot. A daemon from an
 * older build stays in service, since stopping it would end every hosted
 * session, and is reported as stale so the caller can offer a deliberate
 * restart. A daemon on another protocol version stays in service too: the
 * boot rejects with `protocol_mismatch` and a message holding both builds,
 * both versions, and the way to restart it, unless the caller's
 * `onProtocolMismatch` confirms a restart. The expected build is read from
 * disk on every attempt: a long-lived caller holding a build string from
 * its own boot would otherwise flag daemons that are already current.
 */
export async function bootDaemonClient(options: DaemonBootOptions = {}): Promise<DaemonBoot> {
  let waited = false;
  const clock = options.clock ?? systemClock;
  const paths = options.paths ?? PROCESS_PATHS;

  const wait =
    options.waitForDaemonMs === undefined
      ? null
      : {
          deadline: clock.now() + options.waitForDaemonMs,
          timeoutMs: options.waitForDaemonMs,
          clock,
          paths,
          onWait: () => {
            if (!waited) {
              waited = true;
              options.onWaitForDaemon?.();
            }
          },
        };

  for (let attempt = 0; attempt < 2; attempt++) {
    const build = getBuild();

    const opened =
      wait === null
        ? await openOrBootDaemon(paths, options.paths === undefined)
        : await waitForDaemon(wait);

    const client = opened.client;

    try {
      const hello =
        wait === null
          ? await client.sendHello(build)
          : await waitForHello(() => client.sendHello(build), wait);

      return {
        client,
        stale: hello['daemon'] !== build,
        lastUsedAgent: toAgentID(hello['lastUsedAgent']),
        features: parseDaemonFeatures(hello),
        socketPath: opened.socketPath,
      };
    } catch (error) {
      client.stop();

      if (attempt > 0 || !(error instanceof DaemonError) || error.code !== 'protocol_mismatch') {
        throw error;
      }

      const mismatch: ProtocolMismatch = {
        socketPath: opened.socketPath,
        daemonPID: findDaemonPID(opened.socketPath, paths),
        clientBuild: build,
        clientProtocol: PROTOCOL_V,
        daemonMessage: error.message,
      };

      // Without a pid there is no daemon this client could stop, so the
      // caller is not asked.
      if (
        mismatch.daemonPID === null ||
        options.onProtocolMismatch === undefined ||
        !(await options.onProtocolMismatch(mismatch))
      ) {
        throw new DaemonError('protocol_mismatch', formatProtocolMismatch(mismatch));
      }

      await stopDaemon(mismatch.daemonPID);
    }
  }

  throw new Error('the atc daemon could not be restarted');
}

interface OpenedDaemon {
  readonly client: DaemonClient;
  readonly socketPath: string;
}

/**
 * Opens the daemon at the known paths, starting one first when none
 * answers and the boot may start one. A boot that may not start one, since
 * a daemon it started would listen elsewhere, rejects instead.
 */
async function openOrBootDaemon(paths: DaemonPaths, canStart: boolean): Promise<OpenedDaemon> {
  const opened = await tryOpenKnownDaemon(paths);

  if (opened !== null) {
    return opened;
  }

  if (!canStart) {
    throw new Error(formatGivenPathsFailure(paths));
  }

  await bootDaemonOnce();

  const booted = await tryOpenKnownDaemon(paths);

  if (booted === null) {
    throw new Error(formatBootFailure(paths));
  }

  return booted;
}

// The time a waiting boot gives up, and the length of its wait for the
// error text.
interface DaemonWait {
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly paths: DaemonPaths;

  // Called on every miss; the boot reports only the first to its caller.
  readonly onWait: () => void;
}

/**
 * Polls the known sockets until a daemon answers, and never starts one.
 * Each miss reports that the wait goes on.
 */
async function waitForDaemon(wait: DaemonWait): Promise<OpenedDaemon> {
  for (;;) {
    const opened = await tryOpenKnownDaemon(wait.paths);

    if (opened !== null) {
      return opened;
    }

    wait.onWait();

    if (wait.clock.now() >= wait.deadline) {
      throw new Error(formatWaitFailure(wait));
    }

    const polled = Promise.withResolvers<void>();

    wait.clock.schedule(polled.resolve, 100);

    await polled.promise;
  }
}

/**
 * Sends the handshake and rejects once the wait's deadline passes, so a
 * daemon that takes the connection but never answers cannot hold the wait
 * open.
 */
async function waitForHello(
  sendHello: () => Promise<Readonly<Record<string, unknown>>>,
  wait: DaemonWait,
): Promise<Readonly<Record<string, unknown>>> {
  const expired = Promise.withResolvers<never>();

  const cancel = wait.clock.schedule(
    () => {
      expired.reject(new Error(formatWaitFailure(wait)));
    },
    Math.max(0, wait.deadline - wait.clock.now()),
  );

  try {
    return await Promise.race([sendHello(), expired.promise]);
  } finally {
    cancel();
  }
}

/**
 * Tries the socket this environment computes, then the one the running
 * daemon recorded in the state directory: a client whose environment lacks
 * XDG_RUNTIME_DIR computes a different path from the daemon's.
 */
async function tryOpenKnownDaemon(paths: DaemonPaths): Promise<OpenedDaemon | null> {
  const computed = await tryOpenDaemon(paths.socketPath);

  if (computed !== null) {
    return computed;
  }

  const record = findDaemonRecord(paths.recordFile);

  if (record === null || record.socketPath === paths.socketPath) {
    return null;
  }

  return tryOpenDaemon(record.socketPath);
}

async function tryOpenDaemon(socketPath: string): Promise<OpenedDaemon | null> {
  try {
    return { client: await DaemonClient.open(socketPath), socketPath };
  } catch {
    return null;
  }
}

// How long a boot waits for a daemon to answer. It covers a daemon that
// waits out the state lock of one still shutting down.
const BOOT_DEADLINE_MS = 8000;

const bootDaemonOnce = makeSingleFlight(async () => {
  let child = spawnDaemonDetached();
  const deadline = Date.now() + BOOT_DEADLINE_MS;

  while (Date.now() < deadline) {
    await Bun.sleep(100);

    const probe = await tryOpenKnownDaemon(PROCESS_PATHS);

    if (probe !== null) {
      probe.client.stop();

      return;
    }

    // A daemon that found the state lock still held by one shutting down
    // exits; once the old one is gone, a fresh spawn takes the lock.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = spawnDaemonDetached();
    }
  }
});

// A live daemon this process cannot reach, such as one whose runtime
// directory a sandbox hides, needs a different fix than one that never
// started, so the message tells them apart.
function formatBootFailure(paths: DaemonPaths): string {
  return (
    formatUnreachableDaemon(paths) ??
    'the atc daemon did not come up; try `atc daemon` for its output'
  );
}

// A boot given its own paths starts no daemon, since `atc daemon` would
// listen at this process's paths instead, so the message says so.
function formatGivenPathsFailure(paths: DaemonPaths): string {
  return (
    formatUnreachableDaemon(paths) ??
    `no atc daemon answered at ${paths.socketPath}, and a boot given its own daemon paths does not start one; start \`atc daemon\` where it listens there first`
  );
}

function formatUnreachableDaemon(paths: DaemonPaths): string | null {
  const record = findDaemonRecord(paths.recordFile);

  if (record !== null && isProcessAlive(record.pid)) {
    return `the atc daemon (pid ${record.pid}) is running, but its socket ${record.socketPath} is unreachable from here`;
  }

  return null;
}

// A waiting caller was told not to start a daemon, so the message says so
// and points at starting the managed one.
function formatWaitFailure(wait: DaemonWait): string {
  return (
    formatUnreachableDaemon(wait.paths) ??
    `no atc daemon answered at ${wait.paths.socketPath} within ${wait.timeoutMs / 1000}s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`
  );
}

// The pid of the daemon behind the socket that refused the handshake.
function findDaemonPID(socketPath: string, paths: DaemonPaths): number | null {
  return pickStaleDaemonPID({
    socketPath,
    record: findDaemonRecord(paths.recordFile),
    pidFileSocketPath: paths.socketPath,
    pidFilePID: findPidFilePID(paths.pidFile),
  });
}

async function stopDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await Bun.sleep(50);
  }
}

function spawnDaemonDetached(): ChildProcess {
  return spawnATCDetached(['daemon']);
}
