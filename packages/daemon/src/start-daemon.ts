import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_GIT_TRANSPORTS,
  LOCAL_TARGET,
  NODE_TOKEN_FILE_ACCESS,
  buildDaemonStatePaths,
  loadListenerTokens,
} from '@atc/config';
import { claimDaemonLock, readDaemonRecord, writeDaemonRecord } from '@atc/lifecycle';
import type { HarnessRelay } from '@atc/plugin-api';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { getLogger } from '@logtape/logtape';
import { systemClock } from '@zgeoff/std';
import { isBindingCurrent } from './auth/is-binding-current';
import type { BridgeBinding } from './auth/is-binding-current';
import { buildDaemonContext } from './build-daemon-context';
import type { DaemonHandle } from './daemon-handle';
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
import { createRelayPeerSocket } from './transport/create-relay-peer-socket';
import { readSocketSession } from './transport/read-socket-session';
import { requireListenTokens } from './transport/require-listen-tokens';
import { routeBridgeRelay } from './transport/route-bridge-relay';
import { startEventSweep } from './transport/start-event-sweep';
import { startEventsServer } from './transport/start-events-server';
import { startTCPListener } from './transport/start-tcp-listener';
import type { TCPListener } from './transport/start-tcp-listener';
import { tryRemoveExpiredIdempotencyKeys } from './transport/try-remove-expired-idempotency-keys';
import { withOwnerOnlySocket } from './transport/with-owner-only-socket';
import type { DaemonOptions, TapClient } from './types';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SWEEP_MS = 60 * 60 * 1000;
const HANDSHAKE_FAILURE_DELAY_MS = 10_000;
const MAX_DELAYED_HANDSHAKES = 64;
const REFUSAL_LOG_INTERVAL_MS = 60_000;
const MAX_REFUSAL_WINDOWS = 1024;
const LOCK_WAIT_MS = 2000;

export type { DaemonHandle } from './daemon-handle';

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  let stopDaemon: (() => Promise<void>) | null = null;
  const clock = opts.clock ?? systemClock;
  let released = false;

  const listenTokens =
    opts.listen === undefined ? null : requireListenTokens(opts.listen, NODE_TOKEN_FILE_ACCESS);

  const stateDir = dirname(opts.dbPath);
  const statePaths = buildDaemonStatePaths(stateDir);
  const recordPath = statePaths.recordFile;

  const lock = await claimDaemonLock(statePaths.lockFile, LOCK_WAIT_MS, clock);

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

  // Any local process can read this socket, including one running inside a session. It only
  // streams events and accepts no commands, so it checks no session identity.
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

  const runtimes = new Map<SessionID, SessionRuntime>();

  const findRuntime = (sessionID: SessionID) => runtimes.get(sessionID);
  const taps = createTapRegistry<TapClient>();

  const endedProcesses = new Set<SessionID>();

  const onBoot: SessionManager['onBoot'] = (session, cols, rows) => {
    endedProcesses.delete(session.id);

    const runtime = runtimes.get(session.id);

    if (runtime === undefined) {
      return;
    }

    runtime.resetBoot({ cols, rows });

    runtime.screen ??= createScreenModel(cols, rows);

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
      // A removed session has already left the session list, so a lookup by ID finds nothing.
      // Hooks filtered by directory still need its scope when the removal event fires.
      emitEvent(event, { cwd: session.cwd, repoRoot: session.repoRoot });
    }
  };

  const manager = createSessionManager({
    fallback: opts.adapter,
    store,
    statusPath: opts.statusPath,
    adapters: opts.adapters ?? [],
    targets,
    targetErrors,
    events: {
      onBoot,
      onOutput: (session, data) => {
        output.recordOutput(session, data);
      },
      onProcessEnded,
      onEvent,
      onRelay: (binding, relay) => {
        routeBridgeRelay(relay, {
          openBridge: (bridged) => {
            hooks.startRelay(binding, bridged);
          },
          openClient: (client) => {
            openGrantedConnection(binding, client);
          },
        });
      },
      startMessageBridge: (launch) => bridges.startBridge(launch),
      stopMessageBridge: (sessionID) => bridges.stopBridge(sessionID),
    },
  });

  manager.clock = clock;
  manager.reporterSocketPath = opts.reporterSocketPath;

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

  const isBridgeCurrent = (binding: BridgeBinding): boolean =>
    isBindingCurrent(
      binding,
      manager.sessions.find((x) => x.id === binding.sessionID),
    );

  const openGrantedConnection = (binding: BridgeBinding, relay: HarnessRelay): void => {
    if (!isBridgeCurrent(binding) || ctx.findHeldAtcAccess(binding.sessionID) === null) {
      relay.close();

      return;
    }

    const socket = createRelayPeerSocket(relay, () => {
      connection.drain();
    });

    const connection = createDaemonConnection(socket, ctx, null, {
      id: binding.sessionID,
      isBridgeCurrent: () => isBridgeCurrent(binding),
    });

    clients.add(connection);

    relay.onLine((line) => {
      connection.applyChunk(`${line}\n`);
    });

    relay.onEnd(() => {
      connection.endInput();
    });

    relay.onClose(() => {
      connection.dispose();

      detachConnection(connection);
    });
  };

  let tcpListener: TCPListener | null = null;

  if (opts.listen !== undefined && listenTokens !== null) {
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
          socket.data = createDaemonConnection(
            socket,
            ctx,
            null,
            readSocketSession(socket, manager.sessions),
          );

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

    const loaded = loadListenerTokens(opts.listen.tokenFile, NODE_TOKEN_FILE_ACCESS);

    if (loaded.ok) {
      tcpListener.setTokens(loaded.tokens);

      return;
    }

    tcpListener.setTokens(null);

    manager.log(
      `atc daemon: token reload failed (${loaded.reason}); every TCP connection is closed and refused until a reload succeeds`,
    );
  };

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
    major: CONTRACT_MAJOR,
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
