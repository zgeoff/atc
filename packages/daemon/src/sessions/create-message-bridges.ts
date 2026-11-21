import { join } from 'node:path';
import type {
  MessageBridge,
  MessageBridgeHost,
  MessageBridgeTap,
  SpawnPlan,
} from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import type { StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import { toMessageID } from '@atcx/contract';
import type { Clock } from '@zgeoff/std';
import type { TapClient } from '../types';
import { buildBridgeTapClient } from './build-bridge-tap-client';
import { buildMessageOwner } from './build-message-owner';
import type { MessageService } from './create-message-service';
import type { SessionManager } from './create-session-manager';
import type { TapRegistry } from './create-tap-registry';
import { parseNote } from './parse-note';
import type { MessageBridgeLaunch } from './session-callbacks';

interface MessageBridgesDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'log'>;
  readonly store: Pick<StateStore, 'updateNoticeDelivered' | 'readUnsettledMessages'>;
  readonly clock: Pick<Clock, 'now' | 'schedule'>;
  readonly messages: Pick<
    MessageService,
    'attachTap' | 'markMessageDelivered' | 'recordNoticeStatus' | 'drainSessionInbox'
  >;
  readonly taps: Pick<TapRegistry<TapClient>, 'detachAll'>;

  readonly applyNote: (hookEvent: HookEvent) => Promise<void>;

  readonly stateDir: string;
}

export interface MessageBridges {
  readonly startBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  readonly stopBridge: (sessionID: SessionID) => Promise<void>;

  // A bridge's App Server runs beside the daemon, not under a session's
  // terminal, so it ends with the daemon.
  readonly stopAll: () => Promise<void>;

  readonly startDelivery: (sessionID: SessionID) => void;

  readonly updateThread: (sessionID: SessionID, agentSessionID: string) => void;
}

export function createMessageBridges(deps: MessageBridgesDeps): MessageBridges {
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const messages = deps.messages;
  const taps = deps.taps;
  const applyNote = deps.applyNote;
  const stateDir = deps.stateDir;

  const bridges = new Map<SessionID, MessageBridge>();

  const buildHost = (sessionID: SessionID): MessageBridgeHost => {
    const bridgeClients = new Map<MessageBridgeTap, TapClient>();

    const findOwner = () => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      return session === undefined ? null : buildMessageOwner(session);
    };

    return {
      attachTap: (tap) => {
        const client = buildBridgeTapClient(tap);

        bridgeClients.set(tap, client);

        return messages.attachTap(client, sessionID, null, true) === 'ok';
      },
      detachTap: (tap) => {
        const client = bridgeClients.get(tap);

        bridgeClients.delete(tap);

        if (client !== undefined) {
          taps.detachAll(client);
        }
      },
      ackMessage: async (id) => {
        const owner = findOwner();

        if (owner === null) {
          return;
        }

        await messages.markMessageDelivered(sessionID, toMessageID(id), owner);

        void messages.drainSessionInbox(sessionID);
      },
      ackNotice: async (id) => {
        const delivered = await store.updateNoticeDelivered(
          toMessageID(id),
          sessionID,
          clock.now(),
        );

        if (delivered !== null) {
          await messages.recordNoticeStatus(delivered, 'notice-delivered');
        }

        void messages.drainSessionInbox(sessionID);
      },
      applyNote: async (payload) => {
        if (parseNote(payload) === null) {
          return false;
        }

        await applyNote({ atcId: sessionID, event: 'Note', payload: { ...payload } });

        // The bridge settles a message the App Server refused without sending an ack, so no ack path
        // drains the inbox. This drain frees the tap for the next queued message.
        void messages.drainSessionInbox(sessionID);

        return true;
      },
      readUnsettledMessages: async () => {
        const owner = findOwner();

        if (owner === null) {
          return [];
        }

        const unsettled = await store.readUnsettledMessages(owner);

        return unsettled.flatMap((record) =>
          record.status === 'queued' || record.status === 'delivered'
            ? [{ id: record.id, status: record.status }]
            : [],
        );
      },
      log: (line) => {
        manager.log(line);
      },
    };
  };

  // A stop that a second caller asks for while the first one runs waits for the first, since
  // a caller may remove the folder the bridge writes in once its stop resolves.
  const stopping = new Map<SessionID, Set<Promise<void>>>();

  // A bridge whose stop failed may still write in its folder, so the next stop of that session
  // retries it.
  const failedStops = new Map<SessionID, Set<MessageBridge>>();

  const updateFailedStop = (sessionID: SessionID, bridge: MessageBridge, failed: boolean) => {
    const bridgesLeft = new Set(failedStops.get(sessionID));

    if (failed) {
      bridgesLeft.add(bridge);
    } else {
      bridgesLeft.delete(bridge);
    }

    if (bridgesLeft.size === 0) {
      failedStops.delete(sessionID);
    } else {
      failedStops.set(sessionID, bridgesLeft);
    }
  };

  const stopTracked = async (sessionID: SessionID, bridge: MessageBridge): Promise<void> => {
    const stop = bridge.stop();
    const running = stopping.get(sessionID) ?? new Set<Promise<void>>();

    running.add(stop);
    stopping.set(sessionID, running);

    try {
      await stop;

      updateFailedStop(sessionID, bridge, false);
    } catch (error) {
      updateFailedStop(sessionID, bridge, true);
      throw error;
    } finally {
      running.delete(stop);

      if (running.size === 0 && stopping.get(sessionID) === running) {
        stopping.delete(sessionID);
      }
    }
  };

  const starting = new Map<SessionID, Set<Promise<MessageBridge>>>();
  const stoppedStarts = new Set<Promise<MessageBridge>>();

  const stopStartedBridge = async (
    sessionID: SessionID,
    start: Promise<MessageBridge>,
  ): Promise<void> => {
    const bridge = await start.catch(() => null);

    if (bridge !== null) {
      await stopTracked(sessionID, bridge);
    }
  };

  const stopBridge = async (sessionID: SessionID): Promise<void> => {
    const bridge = bridges.get(sessionID);
    const failed = [...(failedStops.get(sessionID) ?? [])];
    const pending = [...(starting.get(sessionID) ?? [])];

    bridges.delete(sessionID);

    for (const start of pending) {
      stoppedStarts.add(start);
    }

    await Promise.all([
      ...(stopping.get(sessionID) ?? []),
      ...[...new Set([...failed, ...(bridge === undefined ? [] : [bridge])])].map((stopped) =>
        stopTracked(sessionID, stopped),
      ),
      ...pending.map((start) => stopStartedBridge(sessionID, start)),
    ]);
  };

  const awaitBridgeStart = async (
    sessionID: SessionID,
    start: Promise<MessageBridge>,
  ): Promise<MessageBridge> => {
    const pending = starting.get(sessionID) ?? new Set<Promise<MessageBridge>>();

    pending.add(start);
    starting.set(sessionID, pending);

    const untrack = () => {
      pending.delete(start);
      stoppedStarts.delete(start);

      if (pending.size === 0 && starting.get(sessionID) === pending) {
        starting.delete(sessionID);
      }
    };

    const bridge = await start.catch((error: unknown) => {
      untrack();
      throw error;
    });

    const stopped = stoppedStarts.has(start);

    untrack();

    if (stopped) {
      return bridge;
    }

    // A second launch of the session can finish starting its bridge while this one is still
    // starting, so the bridge this one replaces is stopped here.
    const replaced = bridges.get(sessionID);

    bridges.set(sessionID, bridge);

    if (replaced !== undefined && replaced !== bridge) {
      await stopTracked(sessionID, replaced);
    }

    return bridge;
  };

  return {
    startBridge: async (launch) => {
      if (launch.adapter.startMessageBridge === undefined) {
        return null;
      }

      await stopBridge(launch.session);

      const bridge = await awaitBridgeStart(
        launch.session,
        launch.adapter.startMessageBridge({
          session: launch.session,
          cwd: launch.cwd,
          env: launch.env,
          withheldEnv: launch.withheldEnv,
          options: launch.options,
          directory: join(stateDir, 'sessions', launch.session, 'codex'),
          host: buildHost(launch.session),
        }),
      );

      return bridge.plan;
    },

    stopBridge,

    stopAll: async () => {
      const sessionIDs = new Set([...bridges.keys(), ...starting.keys()]);

      await Promise.all([...sessionIDs].map((id) => stopBridge(id)));
    },

    startDelivery: (sessionID) => {
      bridges.get(sessionID)?.startDelivery();
    },

    updateThread: (sessionID, agentSessionID) => {
      bridges.get(sessionID)?.updateThread(agentSessionID);
    },
  };
}
