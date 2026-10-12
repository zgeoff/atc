import type { ChildProcess } from 'node:child_process';
import { daemonPidFile, daemonRecordFile, daemonSocketPath } from '@atc/config/config';
import { makeSingleFlight } from '@atc/core/make-single-flight';
import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { toAgentID } from '@atc/core/to-agent-id';
import { waitUntil } from '@atc/core/wait-until';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import type { DaemonBoot } from '@atc/protocol/daemon-boot';
import type { DaemonBootOptions } from '@atc/protocol/daemon-boot-options';
import { DaemonError } from '@atc/protocol/daemon-error';
import type { DaemonPaths } from '@atc/protocol/daemon-paths';
import { formatProtocolMismatch } from '@atc/protocol/format-protocol-mismatch';
import type { ProtocolMismatch } from '@atc/protocol/format-protocol-mismatch';
import { parseDaemonFeatures } from '@atc/protocol/parse-daemon-features';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { readSessionEnv } from '@atc/protocol/read-session-env';
import type { ATCInvocation } from './atc-invocation';
import { findDaemonRecord } from './find-daemon-record';
import { findPidFilePID } from './find-pid-file-pid';
import { isProcessAlive } from './is-process-alive';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';
import { readManagedDaemonUnit } from './read-managed-daemon-unit';
import { restartManagedDaemon } from './restart-managed-daemon';
import { spawnATCDetached } from './spawn-atc-detached';

const PROCESS_PATHS: DaemonPaths = {
  socketPath: daemonSocketPath,
  recordFile: daemonRecordFile,
  pidFile: daemonPidFile,
};

/**
 * Opens a handshaken client to the daemon, booting the daemon first when
 * neither the computed socket nor the one in the daemon's record answers,
 * or waiting for one when a daemon user unit is installed or the caller
 * set `waitForDaemonMs`.
 * Overlapping calls in one process share a single boot. A daemon from an
 * older build stays in service, since stopping it would end every hosted
 * session, and is reported as stale so the caller can offer a deliberate
 * restart. A daemon on another protocol version stays in service too: the
 * boot rejects with `protocol_mismatch` and a message holding both builds,
 * both versions, and the way to restart it, unless the caller's
 * `onProtocolMismatch` confirms a restart. The expected build is read
 * through the invocation on every attempt: a long-lived caller holding a
 * build string from its own boot would otherwise flag daemons that are
 * already current. A daemon the boot starts runs through the invocation's
 * argv.
 */
export async function bootDaemonClient(
  invocation: ATCInvocation,
  options: DaemonBootOptions = {},
): Promise<DaemonBoot> {
  let waited = false;
  const clock = options.clock ?? systemClock;
  const paths = options.paths ?? PROCESS_PATHS;
  const managed = options.paths === undefined && readManagedDaemonUnit() !== null;
  const waitMs = options.waitForDaemonMs ?? (managed ? Number.POSITIVE_INFINITY : undefined);

  const wait =
    waitMs === undefined
      ? null
      : {
          deadline: clock.now() + waitMs,
          timeoutMs: waitMs,
          clock,
          paths,
          onWait: () => {
            if (!waited) {
              waited = true;

              if (options.onWaitForDaemon !== undefined) {
                options.onWaitForDaemon();
              } else if (managed) {
                console.error(
                  'waiting for atc-daemon.service; this client does not start a daemon',
                );
              }
            }
          },
        };

  for (let attempt = 0; attempt < 2; ) {
    const build = invocation.readBuild();

    const opened =
      wait === null
        ? await openOrBootDaemon(paths, options.paths === undefined, clock, invocation.argv)
        : await waitForDaemon(wait);

    const client = opened.client;

    try {
      const hello =
        wait === null
          ? await client.sendHello(build, { session: readSessionEnv(process.env).sessionID })
          : await waitForHello(
              () => client.sendHello(build, { session: readSessionEnv(process.env).sessionID }),
              wait,
            );

      return {
        client,
        stale: hello['daemon'] !== build,
        lastUsedAgent: toAgentID(hello['lastUsedAgent']),
        features: parseDaemonFeatures(hello),
        socketPath: opened.socketPath,
      };
    } catch (error) {
      const closed = client.isClosed();

      client.stop();

      if (wait !== null && closed && clock.now() < wait.deadline) {
        wait.onWait();

        const polled = Promise.withResolvers<void>();

        clock.schedule(polled.resolve, 100);

        await polled.promise;

        continue;
      }

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

      const restart = managed ? restartManagedDaemon() : stopDaemon(mismatch.daemonPID, clock);

      await restart;

      attempt++;
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
async function openOrBootDaemon(
  paths: DaemonPaths,
  canStart: boolean,
  clock: Clock,
  atcArgv: readonly string[],
): Promise<OpenedDaemon> {
  const opened = await tryOpenKnownDaemon(paths);

  if (opened !== null) {
    return opened;
  }

  if (!canStart) {
    throw new Error(formatGivenPathsFailure(paths));
  }

  await bootDaemonOnce(clock, atcArgv);

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
  if (wait.deadline === Number.POSITIVE_INFINITY) {
    return sendHello();
  }

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

// One boot in flight per clock, which every boot of this process on that
// clock shares.
const bootFlights = new WeakMap<Clock, () => Promise<void>>();

/**
 * Starts a daemon and waits on the clock until one answers at the known
 * paths, sharing a boot already in flight on the same clock.
 */
function bootDaemonOnce(clock: Clock, atcArgv: readonly string[]): Promise<void> {
  let flight = bootFlights.get(clock);

  if (flight === undefined) {
    flight = makeSingleFlight(() => bootDaemon(clock, atcArgv));

    bootFlights.set(clock, flight);
  }

  return flight();
}

async function bootDaemon(clock: Clock, atcArgv: readonly string[]): Promise<void> {
  let child = spawnDaemonDetached(atcArgv);

  await waitUntil(
    async () => {
      const probe = await tryOpenKnownDaemon(PROCESS_PATHS);

      if (probe !== null) {
        probe.client.stop();

        return true;
      }

      // A daemon that found the state lock still held by one shutting down
      // exits; once the old one is gone, a fresh spawn takes the lock.
      if (child.exitCode !== null || child.signalCode !== null) {
        child = spawnDaemonDetached(atcArgv);
      }

      return false;
    },
    { clock, intervalMs: 100, deadlineMs: clock.now() + BOOT_DEADLINE_MS },
  );
}

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

async function stopDaemon(pid: number, clock: Clock): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  await waitUntil(
    () => {
      try {
        process.kill(pid, 0);

        return false;
      } catch {
        return true;
      }
    },
    { clock, intervalMs: 50, deadlineMs: clock.now() + 3000 },
  );
}

function spawnDaemonDetached(atcArgv: readonly string[]): ChildProcess {
  return spawnATCDetached(atcArgv, ['daemon']);
}
