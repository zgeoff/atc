import type { ChildProcess } from 'node:child_process';
import { makeSingleFlight } from '@atc/core/make-single-flight';
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
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { collectDaemonSocketPaths } from './collect-daemon-socket-paths';
import { findDaemonPID } from './find-daemon-pid';
import { findDaemonRecord } from './find-daemon-record';
import { findRestartUnit } from './find-restart-unit';
import { isProcessAlive } from './is-process-alive';
import type { LifecycleHost } from './lifecycle-host';
import { restartDaemonProcess } from './restart-daemon-process';
import { spawnATCDetached } from './spawn-atc-detached';

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
 * `onProtocolMismatch` confirms a restart, which takes the refusing daemon
 * out of service the way `atc daemon restart` does. The expected build is
 * read through the host's invocation on every attempt: a long-lived caller
 * holding a build string from its own boot would otherwise flag daemons
 * that are already current. A daemon the boot starts runs through the
 * invocation's argv, and the boot runs on the host's paths and clock unless
 * the options give their own.
 */
export async function bootDaemonClient(
  host: LifecycleHost,
  options: DaemonBootOptions = {},
): Promise<DaemonBoot> {
  let waited = false;
  const clock = options.clock ?? host.clock;
  const paths = options.paths ?? buildHostDaemonPaths(host);
  const managed = options.paths === undefined && host.findManagedUnit() !== null;
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
    const build = host.invocation.readBuild();

    const opened =
      wait === null
        ? await openOrBootDaemon(paths, options.paths === undefined, clock, host.invocation.argv)
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
        daemonPID: findDaemonPID(opened.socketPath, {
          paths,
          stateDir: host.paths.stateDir,
          procRoot: host.procRoot,
        }),
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

      const unit = await findRestartUnit(mismatch.daemonPID, host);

      await restartDaemonProcess(
        { pid: mismatch.daemonPID, unit },
        { clock, runSystemctl: host.runSystemctl },
      );

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

  await bootDaemonOnce(paths, clock, atcArgv);

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

// Opens the first socket a running daemon may answer on that takes the
// connection, sending no handshake.
async function tryOpenKnownDaemon(paths: DaemonPaths): Promise<OpenedDaemon | null> {
  for (const socketPath of collectDaemonSocketPaths(paths)) {
    try {
      return { client: await DaemonClient.open(socketPath), socketPath };
    } catch {
      // A socket that refuses the connection passes the boot to the next.
    }
  }

  return null;
}

// How long a boot waits for a daemon to answer. It covers a daemon that
// waits out the state lock of one still shutting down.
const BOOT_DEADLINE_MS = 8000;

// One boot in flight per clock, which every boot of this process on that
// clock shares.
const bootFlights = new WeakMap<Clock, () => Promise<void>>();

/**
 * Starts a daemon and waits on the clock until one answers at the paths,
 * sharing a boot already in flight on the same clock.
 */
function bootDaemonOnce(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
): Promise<void> {
  let flight = bootFlights.get(clock);

  if (flight === undefined) {
    flight = makeSingleFlight(() => bootDaemon(paths, clock, atcArgv));

    bootFlights.set(clock, flight);
  }

  return flight();
}

async function bootDaemon(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
): Promise<void> {
  let child = spawnDaemonDetached(atcArgv);

  await waitUntil(
    async () => {
      const probe = await tryOpenKnownDaemon(paths);

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

function spawnDaemonDetached(atcArgv: readonly string[]): ChildProcess {
  return spawnATCDetached(atcArgv, ['daemon']);
}
