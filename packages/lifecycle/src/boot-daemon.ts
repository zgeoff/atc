import type { ChildProcess } from 'node:child_process';
import { makeSingleFlight, toAgentID } from '@atc/core';
import type { Clock } from '@atc/core';
import type { DaemonBoot, DaemonBootOptions, DaemonPaths, ProtocolMismatch } from '@atc/protocol';
import {
  MISMATCH_REFUSAL_DATA_SCHEMA,
  formatProtocolMismatch,
  isClientBehind,
} from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { DaemonError, PROTOCOL_V } from '@atc/protocol/wire';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import type { LifecycleHost } from './lifecycle-host';
import { DAEMON_READY_FD_VARIABLE } from './make-daemon-ready-signal';
import { probeProcessAlive } from './probe-process-alive';
import { readDaemonPID } from './read-daemon-pid';
import { readDaemonRecord } from './read-daemon-record';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';
import { readRestartUnit } from './read-restart-unit';
import { restartDaemonProcess } from './restart-daemon-process';
import { spawnATCDetached } from './spawn-atc-detached';

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

  for (let attempt = 0; attempt < 2;) {
    // read on every attempt: a build held since this process booted would flag
    // daemons that are already current as stale.
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

        // an older daemon stays in service, since stopping it would end every
        // hosted session; the caller can offer a deliberate restart.
        stale: hello['daemon'] !== build,
        lastUsedAgent: toAgentID(hello['lastUsedAgent']),
        socketPath: opened.socketPath,
      };
    } catch (error) {
      const closed = client.isClosed();
      const isMismatch = error instanceof DaemonError && error.code === 'protocol_mismatch';

      client.stop();

      // A daemon on another protocol closes the connection as it refuses
      // the handshake, so its refusal ends the wait instead of a new poll.
      if (wait !== null && closed && !isMismatch && clock.now() < wait.deadline) {
        wait.onWait();

        const polled = Promise.withResolvers<void>();

        clock.schedule(polled.resolve, 100);

        await polled.promise;

        continue;
      }

      if (attempt > 0 || !isMismatch) {
        throw error;
      }

      const refusal = MISMATCH_REFUSAL_DATA_SCHEMA.safeParse(error.data ?? {});

      const mismatch: ProtocolMismatch = {
        socketPath: opened.socketPath,
        daemonPID: readDaemonPID(opened.socketPath, {
          paths,
          stateDir: host.paths.stateDir,
          procRoot: host.procRoot,
        }),
        clientBuild: build,
        clientProtocol: PROTOCOL_V,
        daemonProtocol: refusal.data?.daemonProtocol ?? null,
        daemonMessage: error.message,
      };

      // Without a pid there is no daemon this client could stop, so the
      // caller is not asked. A restart cannot help a client older than the
      // daemon either, since the daemon comes back on its own build.
      if (
        mismatch.daemonPID === null ||
        isClientBehind(mismatch) ||
        options.onProtocolMismatch === undefined ||
        !(await options.onProtocolMismatch(mismatch))
      ) {
        throw new DaemonError('protocol_mismatch', formatProtocolMismatch(mismatch));
      }

      const unit = await readRestartUnit(mismatch.daemonPID, host);

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
    throw new Error(readGivenPathsFailure(paths));
  }

  await bootDaemonOnce(paths, clock, atcArgv);

  const booted = await tryOpenKnownDaemon(paths);

  if (booted === null) {
    throw new Error(readBootFailure(paths));
  }

  return booted;
}

// Opens the first socket a running daemon may answer on that takes the
// connection, sending no handshake.
async function tryOpenKnownDaemon(paths: DaemonPaths): Promise<OpenedDaemon | null> {
  for (const socketPath of readDaemonSocketPaths(paths)) {
    try {
      return { client: await openDaemonClient(socketPath), socketPath };
    } catch {
      // A socket that refuses the connection passes the boot to the next.
    }
  }

  return null;
}

// A boot given its own paths starts no daemon, since `atc daemon` would
// listen at this process's paths instead, so the message says so.
function readGivenPathsFailure(paths: DaemonPaths): string {
  return (
    readUnreachableDaemon(paths) ??
    `no atc daemon answered at ${paths.socketPath}, and a boot given its own daemon paths does not start one; start \`atc daemon\` where it listens there first`
  );
}

function readUnreachableDaemon(paths: DaemonPaths): string | null {
  const record = readDaemonRecord(paths.recordFile);

  if (record !== null && probeProcessAlive(record.pid)) {
    return `the atc daemon (pid ${record.pid}) is running, but its socket ${record.socketPath} is unreachable from here`;
  }

  return null;
}

// One boot in flight per clock and daemon socket, which every boot of this
// process on that clock for that socket shares.
const bootFlights = new WeakMap<Clock, Map<string, () => Promise<void>>>();

function bootDaemonOnce(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
): Promise<void> {
  let flights = bootFlights.get(clock);

  if (flights === undefined) {
    flights = new Map();

    bootFlights.set(clock, flights);
  }

  let flight = flights.get(paths.socketPath);

  if (flight === undefined) {
    flight = makeSingleFlight(() => bootDaemon(paths, clock, atcArgv));

    flights.set(paths.socketPath, flight);
  }

  return flight();
}

// How long a boot waits for a daemon to answer. It covers a daemon that
// waits out the state lock of one still shutting down.
const BOOT_DEADLINE_MS = 8000;

async function bootDaemon(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
): Promise<void> {
  const deadline = clock.now() + BOOT_DEADLINE_MS;
  let woken = Promise.withResolvers<void>();

  const wake = () => {
    woken.resolve();
  };

  let child = spawnDaemonDetached(atcArgv, wake);

  try {
    for (;;) {
      const probe = await tryOpenKnownDaemon(paths);

      if (probe !== null) {
        probe.client.stop();

        return;
      }

      // A daemon that found the state lock still held by one shutting down
      // exits; once the old one is gone, a fresh spawn takes the lock.
      if (child.exitCode !== null || child.signalCode !== null) {
        closeReadyPipe(child);

        child = spawnDaemonDetached(atcArgv, wake);
      }

      if (clock.now() >= deadline) {
        return;
      }

      // The poll still finds a daemon that another process started, and
      // paces the spawns when each daemon exits at once.
      const cancel = clock.schedule(wake, 100);

      await woken.promise;

      cancel();

      woken = Promise.withResolvers<void>();
    }
  } finally {
    closeReadyPipe(child);
  }
}

function spawnDaemonDetached(atcArgv: readonly string[], onReady: () => void): ChildProcess {
  const child = spawnATCDetached(atcArgv, ['daemon'], {
    env: { ...process.env, [DAEMON_READY_FD_VARIABLE]: '3' },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });

  const pipe = child.stdio.at(3);

  pipe?.on('data', onReady);

  // A daemon that dies mid-write can break the pipe, and the poll covers
  // that daemon.
  pipe?.on('error', () => {});

  return child;
}

function closeReadyPipe(child: ChildProcess): void {
  child.stdio.at(3)?.destroy();
}

// A live daemon this process cannot reach, such as one whose runtime
// directory a sandbox hides, needs a different fix than one that never
// started, so the message tells them apart.
function readBootFailure(paths: DaemonPaths): string {
  return (
    readUnreachableDaemon(paths) ??
    'the atc daemon did not come up; try `atc daemon` for its output'
  );
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

async function waitForDaemon(wait: DaemonWait): Promise<OpenedDaemon> {
  for (;;) {
    const opened = await tryOpenKnownDaemon(wait.paths);

    if (opened !== null) {
      return opened;
    }

    wait.onWait();

    if (wait.clock.now() >= wait.deadline) {
      throw new Error(readWaitFailure(wait));
    }

    const polled = Promise.withResolvers<void>();

    wait.clock.schedule(polled.resolve, 100);

    await polled.promise;
  }
}

// A waiting caller was told not to start a daemon, so the message says so
// and points at starting the managed one.
function readWaitFailure(wait: DaemonWait): string {
  return (
    readUnreachableDaemon(wait.paths) ??
    `no atc daemon answered at ${wait.paths.socketPath} within ${wait.timeoutMs / 1000}s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`
  );
}

// the deadline rejects so a daemon that takes the connection but never
// answers cannot hold the wait open.
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
      expired.reject(new Error(readWaitFailure(wait)));
    },
    Math.max(0, wait.deadline - wait.clock.now()),
  );

  try {
    return await Promise.race([sendHello(), expired.promise]);
  } finally {
    cancel();
  }
}
