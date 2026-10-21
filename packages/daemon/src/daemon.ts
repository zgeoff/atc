import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_GIT_TRANSPORTS, LOCAL_TARGET, loadListenerTokens } from '@atc/config';
import type { SessionID } from '@atc/core';
import { systemClock } from '@atc/core';
import { claimDaemonLock, readDaemonRecord, writeDaemonRecord } from '@atc/lifecycle';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import { getLogger } from '@logtape/logtape';
import { buildDaemonContext } from './build-daemon-context';
import type { TapClient } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import { updateEndedFleetMessages } from './fleet/update-ended-fleet-messages';
import { buildSessionEvent } from './sessions/build-session-event';
import { createPermissionPrompts } from './sessions/create-permission-prompts';
import { createScreenModel } from './sessions/create-screen-model';
import { createSessionManager } from './sessions/create-session-manager';
import type { SessionManager } from './sessions/create-session-manager';
import { createSessionRuntime } from './sessions/create-session-runtime';
import type { SessionRuntime } from './sessions/create-session-runtime';
import { createTapRegistry } from './sessions/create-tap-registry';
import { emitInboxClosed } from './sessions/emit-inbox-closed';
import { makeHookRunner } from './sessions/make-hook-runner';
import type { HookScope } from './sessions/make-hook-runner';
import { startSessionServices } from './start-session-services';
import { buildBindRefusal } from './transport/build-bind-refusal';
import { createDaemonConnection } from './transport/create-daemon-connection';
import type { DaemonConnection } from './transport/create-daemon-connection';
import { createEventSignal } from './transport/create-event-signal';
import { readPeerPID } from './transport/read-peer-pid';
import { readPeerSession } from './transport/read-peer-session';
import { requireListenTokens } from './transport/require-listen-tokens';
import { startEventSweep } from './transport/start-event-sweep';
import { startEventsServer } from './transport/start-events-server';
import { startTCPListener } from './transport/start-tcp-listener';
import type { TCPListener } from './transport/start-tcp-listener';
import { tryRemoveExpiredIdempotencyKeys } from './transport/try-remove-expired-idempotency-keys';
import { withOwnerOnlySocket } from './transport/with-owner-only-socket';

export interface DaemonHandle {
  // A second stop, or a disposal after one, waits on the first and stops
  // nothing again.
  readonly stop: () => Promise<void>;

  readonly [Symbol.asyncDispose]: () => Promise<void>;

  // How many client-protocol connections are open right now.
  readonly countClients: () => number;

  // How many event reads are waiting right now for the trail to grow.
  readonly countEventWaiters: () => number;

  // The port the TCP listener bound, or null without one.
  readonly listenPort: number | null;

  // Reads the token file again and closes every TCP connection whose
  // handshake token it no longer holds. A file that fails to load drops
  // every token and closes every TCP connection until a load succeeds.
  readonly refreshTokens: () => void;
}

// A completed idempotency key is kept this long after it completed, and the
// sweep that drops older ones runs this often.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SWEEP_MS = 60 * 60 * 1000;

// How long a TCP handshake waits once its address has failed too often.
const HANDSHAKE_FAILURE_DELAY_MS = 10_000;

// How many delayed handshakes may wait at once; a handshake over the cap is
// refused at once.
const MAX_DELAYED_HANDSHAKES = 64;

// How long the TCP listener folds repeated refusals from one peer into one
// log line.
const REFUSAL_LOG_INTERVAL_MS = 60_000;

// How many peers and kinds of refusal the TCP listener's refusal log tracks
// at once.
const MAX_REFUSAL_WINDOWS = 1024;

// How long startup waits for a daemon that is shutting down to release the
// state lock before refusing to start.
const LOCK_WAIT_MS = 2000;

// The first request on a connection must be `daemon.hello`. An unknown method is an error, never
// a disconnect; a malformed or oversized line disconnects, because the transport guarantees byte
// integrity and such a line means a buggy or hostile peer.
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  let stopDaemon: (() => Promise<void>) | null = null;
  const clock = opts.clock ?? systemClock;

  // Set once the daemon begins to release what it holds.
  let released = false;

  // The listener's address and tokens are checked before the daemon takes
  // anything, so a refused listener leaves no state behind.
  const listenTokens = opts.listen === undefined ? null : requireListenTokens(opts.listen);

  // One daemon per state directory: the lock comes before the store, the
  // sockets, or the fleet, so a second daemon touches none of them.
  const stateDir = dirname(opts.dbPath);
  const recordPath = join(stateDir, 'daemon.json');

  const lock = await claimDaemonLock(join(stateDir, 'daemon.lock'), LOCK_WAIT_MS);

  if (lock === null) {
    const holder = readDaemonRecord(recordPath);
    const where = holder === null ? '' : ` (pid ${holder.pid}, socket ${holder.socketPath})`;

    throw Object.assign(
      new Error(`atc daemon: another daemon already serves ${stateDir}${where}`),
      { code: 'daemon_locked' },
    );
  }

  if (opts.pidPath !== undefined) {
    writeFileSync(opts.pidPath, String(process.pid));
  }

  const store = await createStateStore(opts.dbPath);

  // Before any request is served: a workspace a stopped daemon left short
  // of ready fails as interrupted, and a key left in progress by a daemon
  // that stopped mid-effect is settled, so no retry can race either.
  await store.reconcileMaterializations(clock.now());
  await store.reconcileIdempotencyKeys(clock.now());
  await store.reconcileAuthBindings(clock.now());

  await tryRemoveExpiredIdempotencyKeys(store, clock, IDEMPOTENCY_TTL_MS);

  const idempotencySweep = setInterval(() => {
    void tryRemoveExpiredIdempotencyKeys(store, clock, IDEMPOTENCY_TTL_MS);
  }, IDEMPOTENCY_SWEEP_MS);

  idempotencySweep.unref();

  const stopEventSweep = await startEventSweep({
    store,
    clock,
    sweepClock: opts.eventSweepClock ?? systemClock,
  });

  const targets = opts.targets;
  const targetErrors = opts.targetErrors ?? [];
  const principals = opts.principals ?? null;
  const gitTransports = opts.gitTransports ?? DEFAULT_GIT_TRANSPORTS;

  const targetsByID = new Map(targets.map((target) => [target.id, target]));

  const defaultTarget =
    opts.defaultTarget === undefined
      ? (targets.find((target) => target.id === LOCAL_TARGET.id)?.id ?? null)
      : opts.defaultTarget;

  const clients = new Set<DaemonConnection>();

  const runHooks = makeHookRunner(opts.hooks ?? {}, { clock });

  // From the pid the kernel holds for the socket's peer and the live harness processes of the
  // sessions; null outside every session and where the kernel cannot be asked.
  const readSocketSession = (socket: object): SessionID | null => {
    const pid = readPeerPID(socket);

    if (pid === null) {
      return null;
    }

    const harnesses = new Map<number, SessionID>();

    for (const session of manager.sessions) {
      if (session.pty?.pid !== undefined) {
        harnesses.set(session.pty.pid, session.id);
      }
    }

    return readPeerSession(pid, harnesses);
  };

  // Any local process reads the events socket, a process inside a session
  // too: the socket only streams, so the session a peer runs inside binds
  // nothing on it.
  const eventsServer =
    opts.eventsSocketPath === undefined
      ? null
      : startEventsServer({
          socketPath: opts.eventsSocketPath,
          collectSnapshot: () =>
            manager.collectDescriptors().map((session) => ({
              version: PROTOCOL_V,
              ev: 'SessionAdded',
              session,
            })),
          ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
        });

  const emitEvent = (event: EventMsg, scope: HookScope | null = null) => {
    for (const client of clients) {
      client.sendEvent(event);
    }

    eventsServer?.broadcast(event);
    runHooks(event, scope);
  };

  const findHookScope = (sessionID: SessionID): HookScope | null => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    return session === undefined ? null : { cwd: session.cwd, repoRoot: session.repoRoot };
  };

  const permissions = createPermissionPrompts({ clock, emitEvent, findHookScope });
  const eventSignal = createEventSignal(clock);

  // One runtime per live session, created when the session manager announces it and disposed the
  // moment it is removed, so removal is a single lookup plus dispose.
  const runtimes = new Map<SessionID, SessionRuntime>();

  const findRuntime = (sessionID: SessionID) => runtimes.get(sessionID);
  const taps = createTapRegistry<TapClient>();

  // The sessions whose process end the daemon saw, until a harness starts
  // for them again.
  const endedProcesses = new Set<SessionID>();

  // A spawned terminal starts on a fresh screen; a revived one keeps the
  // screen its session already had.
  const onBoot: SessionManager['onBoot'] = (session, cols, rows) => {
    endedProcesses.delete(session.id);

    const runtime = runtimes.get(session.id);

    if (runtime === undefined) {
      return;
    }

    runtime.resetBoot({ cols, rows });

    runtime.screen ??= createScreenModel(cols, rows);

    // A bridge delivers only once its session lists and its terminal boots.
    bridges.startDelivery(session.id);
  };

  const onProcessEnded: SessionManager['onProcessEnded'] = (session) => {
    endedProcesses.add(session.id);
    void bridges.stopBridge(session.id);
    void messages.updateEndedSessionMessages(session);
  };

  const onEvent: SessionManager['onEvent'] = (kind, session) => {
    permissions.recordSessionEvent(kind, session);

    if (kind === 'removed') {
      endedProcesses.delete(session.id);
      void bridges.stopBridge(session.id);
      void messages.updateEndedSessionMessages(session, true);
    }

    if (kind === 'added') {
      runtimes.set(session.id, createSessionRuntime());
    }

    // A revive that dies before it ever announces itself must still release
    // the staggered restore, or a failed resume would hold up the fleet.
    if (kind === 'state' && session.pty === null) {
      runtimes.get(session.id)?.bootWaiter?.();
    }

    if (kind === 'removed') {
      output.removeSession(session.id);

      emitInboxClosed(taps.removeSession(session.id), session.id, 'removed');
      runtimes.get(session.id)?.dispose();
      runtimes.delete(session.id);
    }

    const event = buildSessionEvent(manager, kind, session);

    if (event !== null) {
      // The scope comes from the session object rather than a descriptor
      // lookup, so dir-filtered hooks still fire for a removed session.
      emitEvent(event, { cwd: session.cwd, repoRoot: session.repoRoot });
    }
  };

  // The manager takes every callback above when it is built, so no session
  // event arrives before its handler exists.
  const manager = createSessionManager(
    opts.adapter,
    store,
    opts.statusPath,
    opts.adapters ?? [],
    targets,
    targetErrors,
    {
      onBoot,
      onOutput: (session, data) => {
        output.recordOutput(session, data);
      },
      onProcessEnded,
      onEvent,
      onRelay: (binding, relay) => {
        hooks.startRelay(binding, relay);
      },
      startMessageBridge: (launch) => bridges.startBridge(launch),
      stopMessageBridge: (sessionID) => bridges.stopBridge(sessionID),
    },
  );

  manager.clock = clock;

  if (opts.log !== undefined) {
    manager.log = opts.log;
  }

  if (opts.failedSpawnExitWaitMs !== undefined) {
    manager.failedSpawnExitWaitMs = opts.failedSpawnExitWaitMs;
  }

  const services = startSessionServices({
    opts,
    manager,
    store,
    clock,
    stateDir,
    targets,
    targetsByID,
    targetErrors,
    gitTransports,
    defaultTarget,
    taps,
    findRuntime,
    eventSignal,
    emitEvent,
    findHookScope,
    endedProcesses,
    isStopped: () => released,
  });

  const messages = services.messages;
  const hooks = services.hooks;
  const bridges = services.bridges;
  const output = services.output;
  const reporter = services.reporter;
  const revival = services.revival;
  const restorer = services.restorer;

  const ctx = buildDaemonContext({
    opts,
    store,
    manager,
    clock,
    targets,
    targetsByID,
    principals,
    permissions,
    services,
    idempotencyRetentionMs: IDEMPOTENCY_TTL_MS,
    emitEvent,
    stopDaemon: () => stopDaemon?.(),
  });

  // Releases everything the daemon holds except its listeners, on a stop
  // and on a start that fails once it holds the lock.
  const releaseResources = async () => {
    released = true;

    clearInterval(idempotencySweep);
    stopEventSweep();
    eventsServer?.stop();
    reporter.stop(true);
    revival.stop();
    manager.detachAll();

    await Promise.all(
      targets.flatMap((target) => {
        const disposed = target.provider?.dispose();

        return disposed instanceof Promise ? [disposed] : [];
      }),
    );

    for (const runtime of runtimes.values()) {
      runtime.dispose();
    }

    runtimes.clear();

    await bridges.stopAll();

    eventSignal.dispose();

    await store.stop();

    try {
      unlinkSync(recordPath);
    } catch {}

    if (opts.pidPath !== undefined) {
      try {
        unlinkSync(opts.pidPath);
      } catch {}
    }

    lock.dispose();
  };

  const detachConnection = (connection: DaemonConnection) => {
    clients.delete(connection);
    ctx.detachClient(connection);
    taps.detachAll(connection);
  };

  // The TCP listener binds before the unix socket, so a bind that fails
  // refuses the start before any client can connect, and releases what the
  // daemon holds, the lock included.
  let tcpListener: TCPListener | null = null;

  if (opts.listen !== undefined && listenTokens !== null) {
    // A daemon given no log writes the listener's lines through LogTape,
    // which the process configures.
    const tcpLogger = getLogger(['atc', 'tcp']);

    const listenerLog =
      opts.log ??
      ((line: string) => {
        tcpLogger.info('{line}', { line });
      });

    try {
      tcpListener = startTCPListener({
        host: opts.listen.host,
        port: opts.listen.port,
        tokens: listenTokens,
        failureDelayMs: opts.listen.failureDelayMs ?? HANDSHAKE_FAILURE_DELAY_MS,
        maxDelayedHandshakes: opts.listen.maxDelayedHandshakes ?? MAX_DELAYED_HANDSHAKES,
        openConnection: (socket, peer) => {
          const connection = createDaemonConnection(socket, ctx, peer);

          clients.add(connection);

          return connection;
        },
        closeConnection: detachConnection,
        log: listenerLog,
        refusalLogIntervalMs: opts.listen.refusalLogIntervalMs ?? REFUSAL_LOG_INTERVAL_MS,
        maxRefusalWindows: opts.listen.maxRefusalWindows ?? MAX_REFUSAL_WINDOWS,
        clock,
      });
    } catch (error) {
      await releaseResources();

      throw buildBindRefusal(opts.listen, error);
    }
  }

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = withOwnerOnlySocket(opts.socketPath, () =>
    Bun.listen<DaemonConnection>({
      unix: opts.socketPath,
      socket: {
        open(socket) {
          socket.data = createDaemonConnection(socket, ctx, null, readSocketSession(socket));

          clients.add(socket.data);
        },
        data(socket, buf) {
          socket.data.applyChunk(socket.data.decodeChunk(buf));
        },
        drain(socket) {
          socket.data.drain();
        },
        close(socket) {
          detachConnection(socket.data);
        },
        error() {},
      },
    }),
  );

  const refreshTokens = () => {
    if (opts.listen === undefined || tcpListener === null) {
      return;
    }

    const loaded = loadListenerTokens(opts.listen.tokenFile);

    if (loaded.ok) {
      tcpListener.setTokens(loaded.tokens);

      return;
    }

    tcpListener.setTokens(null);

    manager.log(
      `atc daemon: token reload failed (${loaded.reason}); every TCP connection is closed and refused until a reload succeeds`,
    );
  };

  // The stop under way or done, which a quit, a second stop, and a disposal
  // all wait on instead of releasing anything twice; a stop that fails is
  // forgotten, so the next one retries the release.
  let stopping: Promise<void> | null = null;

  stopDaemon = async () => {
    stopping ??= (async () => {
      // Ends each client itself so every peer sees the close: a stopped
      // listener does not reliably end the connections it already accepted.
      for (const client of clients) {
        client.dispose();
      }

      tcpListener?.stop();
      server.stop(true);

      await releaseResources();
    })();

    const current = stopping;

    try {
      await current;
    } catch (error) {
      if (stopping === current) {
        stopping = null;
      }

      throw error;
    }
  };

  writeDaemonRecord(recordPath, {
    pid: process.pid,
    socketPath: opts.socketPath,
    reporterSocketPath: opts.reporterSocketPath,
    eventsSocketPath: opts.eventsSocketPath ?? null,
    listenPort: tcpListener?.port ?? null,
    protocol: PROTOCOL_V,
  });

  await updateEndedFleetMessages({ manager, store, messages });

  await restorer.startBootRestore(opts.restoreFleetOnRestart === true);

  return {
    stop: stopDaemon,
    [Symbol.asyncDispose]: stopDaemon,
    countClients: () => clients.size,
    countEventWaiters: () => eventSignal.countWaiters(),
    listenPort: tcpListener?.port ?? null,
    refreshTokens,
  };
}
