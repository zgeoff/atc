import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { makeSingleFlight, toAgentID } from '@atc/core';
import type { Clock } from '@atc/core';
import type { DaemonBoot, DaemonBootOptions, DaemonPaths, ProtocolMismatch } from '@atc/protocol';
import { formatProtocolMismatch, isClientBehind } from '@atc/protocol';
import { createDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { MISMATCH_REFUSAL_DATA_SCHEMA } from '@atcx/contract';
import { AtcError, CONTRACT_MAJOR } from '@atcx/contract/light';
import { buildHostDaemonPaths } from '../daemon-files/build-host-daemon-paths';
import { readDaemonPID } from '../daemon-files/read-daemon-pid';
import { readDaemonRecord } from '../daemon-files/read-daemon-record';
import { readDaemonSocketPaths } from '../daemon-files/read-daemon-socket-paths';
import { probeProcessAlive } from '../daemon-process/probe-process-alive';
import { readRestartUnit } from '../restart/read-restart-unit';
import { restartDaemonProcess } from '../restart/restart-daemon-process';
import { DAEMON_READY_FD_VARIABLE } from './make-daemon-ready-signal';
import { spawnATCDetached } from './spawn-atc-detached';
import type { LifecycleHost } from './types';

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
        ? await openOrBootDaemon({
            paths,
            canStart: options.paths === undefined,
            clock,
            atcArgv: host.invocation.argv,
            build,
          })
        : await waitForDaemon(wait, build);

    const client = opened.client;

    try {
      const hello = readHelloAnswer(opened.hello);

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
      const isMismatch = error instanceof AtcError && error.code === 'protocol_mismatch';

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
        clientMajor: CONTRACT_MAJOR,
        daemonMajor: refusal.data?.daemonMajor ?? null,
        daemonMessage: error.message,
      };

      if (
        mismatch.daemonPID === null ||
        isClientBehind(mismatch) ||
        options.onProtocolMismatch === undefined ||
        !(await options.onProtocolMismatch(mismatch))
      ) {
        throw new AtcError('protocol_mismatch', formatProtocolMismatch(mismatch));
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

type HelloOutcome =
  | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: unknown };

interface OpenedDaemon {
  readonly client: DaemonClient;
  readonly socketPath: string;

  // The answer to the hello that found the daemon, or its refusal.
  readonly hello: HelloOutcome;
}

interface OpenOrBootOptions {
  readonly paths: DaemonPaths;
  readonly canStart: boolean;
  readonly clock: Clock;
  readonly atcArgv: readonly string[];
  readonly build: string;
}

async function openOrBootDaemon(options: OpenOrBootOptions): Promise<OpenedDaemon> {
  const opened = await tryOpenKnownDaemon(options.paths, options.build, null);

  if (opened !== null) {
    return opened;
  }

  if (!options.canStart) {
    throw new Error(readGivenPathsFailure(options.paths));
  }

  await bootDaemonOnce(options.paths, options.clock, options.atcArgv, options.build);

  const booted = await tryOpenKnownDaemon(options.paths, options.build, null);

  if (booted === null) {
    throw new Error(readBootFailure(options.paths));
  }

  return booted;
}

interface DaemonWait {
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly paths: DaemonPaths;

  readonly onWait: () => void;
}

async function tryOpenKnownDaemon(
  paths: DaemonPaths,
  build: string,
  wait: DaemonWait | null,
): Promise<OpenedDaemon | null> {
  for (const socketPath of readDaemonSocketPaths(paths)) {
    // no socket file, no daemon: the hello is left for a socket that exists
    if (!existsSync(socketPath)) {
      continue;
    }

    const client = createDaemonClient(socketPath);
    const session = readSessionEnv(process.env).sessionID;
    const sendHello = () => client.sendHello(build, { session });
    const sending = wait === null ? sendHello() : waitForHello(sendHello, wait);

    const hello = await settleHello(sending);

    if (!hello.ok && hello.error instanceof AtcError && hello.error.code === 'no_daemon') {
      // A socket that refuses the connection passes the boot to the next.
      continue;
    }

    return { client, socketPath, hello };
  }

  return null;
}

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

function readWaitFailure(wait: DaemonWait): string {
  return (
    readUnreachableDaemon(wait.paths) ??
    `no atc daemon answered at ${wait.paths.socketPath} within ${wait.timeoutMs / 1000}s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`
  );
}

function readUnreachableDaemon(paths: DaemonPaths): string | null {
  const record = readDaemonRecord(paths.recordFile);

  if (record !== null && probeProcessAlive(record.pid)) {
    return `the atc daemon (pid ${record.pid}) is running, but its socket ${record.socketPath} is unreachable from here`;
  }

  return null;
}

async function settleHello(
  sending: Promise<Readonly<Record<string, unknown>>>,
): Promise<HelloOutcome> {
  try {
    return { ok: true, answer: await sending };
  } catch (error) {
    return { ok: false, error };
  }
}

function readGivenPathsFailure(paths: DaemonPaths): string {
  return (
    readUnreachableDaemon(paths) ??
    `no atc daemon answered at ${paths.socketPath}, and a boot given its own daemon paths does not start one; start \`atc daemon\` where it listens there first`
  );
}

const bootFlights = new WeakMap<Clock, Map<string, () => Promise<void>>>();

function bootDaemonOnce(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
  build: string,
): Promise<void> {
  let flights = bootFlights.get(clock);

  if (flights === undefined) {
    flights = new Map();

    bootFlights.set(clock, flights);
  }

  let flight = flights.get(paths.socketPath);

  if (flight === undefined) {
    flight = makeSingleFlight(() => bootDaemon(paths, clock, atcArgv, build));

    flights.set(paths.socketPath, flight);
  }

  return flight();
}

const BOOT_DEADLINE_MS = 8000;

async function bootDaemon(
  paths: DaemonPaths,
  clock: Clock,
  atcArgv: readonly string[],
  build: string,
): Promise<void> {
  const deadline = clock.now() + BOOT_DEADLINE_MS;
  let woken = Promise.withResolvers<void>();

  const wake = () => {
    woken.resolve();
  };

  let child = spawnDaemonDetached(atcArgv, wake);

  try {
    for (;;) {
      const probe = await tryOpenKnownDaemon(paths, build, null);

      if (probe !== null) {
        probe.client.stop();

        return;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        closeReadyPipe(child);

        child = spawnDaemonDetached(atcArgv, wake);
      }

      if (clock.now() >= deadline) {
        return;
      }

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

  // A daemon that dies mid-write can break the pipe, and the boot poll still
  // finds that daemon.
  pipe?.on('error', () => {});

  return child;
}

function closeReadyPipe(child: ChildProcess): void {
  child.stdio.at(3)?.destroy();
}

function readBootFailure(paths: DaemonPaths): string {
  return (
    readUnreachableDaemon(paths) ??
    'the atc daemon did not come up; try `atc daemon` for its output'
  );
}

async function waitForDaemon(wait: DaemonWait, build: string): Promise<OpenedDaemon> {
  for (;;) {
    const opened = await tryOpenKnownDaemon(wait.paths, build, wait);

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

function readHelloAnswer(outcome: HelloOutcome): Readonly<Record<string, unknown>> {
  if (!outcome.ok) {
    throw outcome.error;
  }

  return outcome.answer;
}
