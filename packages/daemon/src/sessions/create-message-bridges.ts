import { join } from 'node:path';
import type { Clock, SessionID } from '@atc/core';
import { toMessageID } from '@atc/core';
import type {
  MessageBridge,
  MessageBridgeHost,
  MessageBridgeTap,
  SpawnPlan,
} from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import type { StateStore } from '@atc/store';
import type { TapClient } from '../daemon-context';
import { buildBridgeTapClient } from './build-bridge-tap-client';
import { buildMessageOwner } from './build-message-owner';
import type { MessageService } from './create-message-service';
import type { TapRegistry } from './create-tap-registry';
import { parseNote } from './parse-note';
import type { MessageBridgeLaunch } from './session-callbacks';
import type { SessionManager } from './sessions';

interface MessageBridgesDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'log'>;
  readonly store: Pick<
    StateStore,
    'updateMessageDelivered' | 'updateNoticeDelivered' | 'readUnsettledMessages'
  >;
  readonly clock: Clock;
  readonly messages: Pick<
    MessageService,
    'attachTap' | 'recordMessageStatus' | 'recordNoticeStatus' | 'drainSessionInbox'
  >;
  readonly taps: Pick<TapRegistry<TapClient>, 'detachAll'>;

  // Lands a note as the reporter's would.
  readonly applyNote: (hookEvent: HookEvent) => Promise<void>;

  // The daemon's state directory, under which each bridge keeps its files.
  readonly stateDir: string;
}

// a bridge's tap, acks, and notes act for its own session alone
export interface MessageBridges {
  // Starts the bridge a launch's agent has, stopping the session's earlier
  // one first, and answers with the plan the terminal starts against it;
  // null for an agent with no bridge.
  readonly startBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  readonly stopBridge: (sessionID: SessionID) => Promise<void>;

  // A bridge's App Server runs beside the daemon, not under a session's
  // terminal, so it ends with the daemon.
  readonly stopAll: () => Promise<void>;

  // A bridge delivers only once its session lists and its terminal boots.
  readonly startDelivery: (sessionID: SessionID) => void;

  // Moves the session's bridge to the conversation its terminal shows.
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

        const delivered = await store.updateMessageDelivered(toMessageID(id), owner, clock.now());

        if (delivered !== null) {
          await messages.recordMessageStatus(sessionID, delivered);
        }

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

        // A message the bridge settled without an ack, as one the App
        // Server refused, frees the tap for the next one.
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

  const stopBridge = async (sessionID: SessionID): Promise<void> => {
    const bridge = bridges.get(sessionID);

    bridges.delete(sessionID);

    await bridge?.stop();
  };

  return {
    startBridge: async (launch) => {
      if (launch.adapter.startMessageBridge === undefined) {
        return null;
      }

      await stopBridge(launch.session);

      const bridge = await launch.adapter.startMessageBridge({
        session: launch.session,
        cwd: launch.cwd,
        env: launch.env,
        withheldEnv: launch.withheldEnv,
        options: launch.options,
        directory: join(stateDir, 'sessions', launch.session, 'codex'),
        host: buildHost(launch.session),
      });

      // A second launch of the session can start its bridge while this one
      // started, so the bridge this one replaces stops here.
      const replaced = bridges.get(launch.session);

      bridges.set(launch.session, bridge);

      if (replaced !== undefined && replaced !== bridge) {
        await replaced.stop();
      }

      return bridge.plan;
    },

    stopBridge,

    stopAll: async () => {
      await Promise.all([...bridges.keys()].map((id) => stopBridge(id)));
    },

    startDelivery: (sessionID) => {
      bridges.get(sessionID)?.startDelivery();
    },

    updateThread: (sessionID, agentSessionID) => {
      bridges.get(sessionID)?.updateThread(agentSessionID);
    },
  };
}
