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
import type { MessageService } from './message-service';
import { parseNote } from './parse-note';
import type { MessageBridgeLaunch } from './session-callbacks';
import type { SessionManager } from './sessions';
import type { TapRegistry } from './tap-registry';

interface MessageBridgesDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'log'>;
  readonly store: Pick<
    StateStore,
    'updateMessageDelivered' | 'updateNoticeDelivered' | 'collectUnsettledMessages'
  >;
  readonly clock: Clock;
  readonly messages: Pick<
    MessageService,
    'attachTap' | 'recordMessageStatus' | 'recordNoticeStatus' | 'drainSessionInbox'
  >;
  readonly taps: Pick<TapRegistry<TapClient>, 'detachAll'>;

  // Lands a note as the reporter's would.
  readonly applyNote: (e: HookEvent) => Promise<void>;

  // The daemon's state directory, under which each bridge keeps its files.
  readonly stateDir: string;
}

// a bridge's tap, acks, and notes act for its own session alone
export class MessageBridges {
  private readonly mgr: MessageBridgesDeps['mgr'];

  private readonly store: MessageBridgesDeps['store'];

  private readonly clock: Clock;

  private readonly messages: MessageBridgesDeps['messages'];

  private readonly taps: MessageBridgesDeps['taps'];

  private readonly applyNote: MessageBridgesDeps['applyNote'];

  private readonly stateDir: string;

  private readonly bridges = new Map<SessionID, MessageBridge>();

  constructor(deps: MessageBridgesDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.clock = deps.clock;
    this.messages = deps.messages;
    this.taps = deps.taps;
    this.applyNote = deps.applyNote;
    this.stateDir = deps.stateDir;
  }

  // Starts the bridge a launch's agent has, stopping the session's earlier
  // one first, and answers with the plan the terminal starts against it;
  // null for an agent with no bridge.
  async startBridge(launch: MessageBridgeLaunch): Promise<SpawnPlan | null> {
    if (launch.adapter.startMessageBridge === undefined) {
      return null;
    }

    await this.stopBridge(launch.session);

    const bridge = await launch.adapter.startMessageBridge({
      session: launch.session,
      cwd: launch.cwd,
      env: launch.env,
      withheldEnv: launch.withheldEnv,
      options: launch.options,
      dir: join(this.stateDir, 'sessions', launch.session, 'codex'),
      host: this.buildHost(launch.session),
    });

    // A second launch of the session can start its bridge while this one
    // started, so the bridge this one replaces stops here.
    const replaced = this.bridges.get(launch.session);

    this.bridges.set(launch.session, bridge);

    if (replaced !== undefined && replaced !== bridge) {
      await replaced.stop();
    }

    return bridge.plan;
  }

  async stopBridge(sessionID: SessionID): Promise<void> {
    const bridge = this.bridges.get(sessionID);

    this.bridges.delete(sessionID);

    await bridge?.stop();
  }

  // A bridge's App Server runs beside the daemon, not under a session's
  // terminal, so it ends with the daemon.
  async stopAll(): Promise<void> {
    await Promise.all([...this.bridges.keys()].map((id) => this.stopBridge(id)));
  }

  // A bridge delivers only once its session lists and its terminal boots.
  startDelivery(sessionID: SessionID): void {
    this.bridges.get(sessionID)?.startDelivery();
  }

  // Moves the session's bridge to the conversation its terminal shows.
  updateThread(sessionID: SessionID, agentSessionID: string): void {
    this.bridges.get(sessionID)?.updateThread(agentSessionID);
  }

  private buildHost(sessionID: SessionID): MessageBridgeHost {
    const bridgeClients = new Map<MessageBridgeTap, TapClient>();

    const findOwner = () => {
      const s = this.mgr.sessions.find((x) => x.id === sessionID);

      return s === undefined ? null : buildMessageOwner(s);
    };

    return {
      attachTap: (tap) => {
        const client = buildBridgeTapClient(tap);

        bridgeClients.set(tap, client);

        return this.messages.attachTap(client, sessionID, null, true) === 'ok';
      },
      detachTap: (tap) => {
        const client = bridgeClients.get(tap);

        bridgeClients.delete(tap);

        if (client !== undefined) {
          this.taps.detachAll(client);
        }
      },
      ackMessage: async (id) => {
        const owner = findOwner();

        if (owner === null) {
          return;
        }

        const delivered = await this.store.updateMessageDelivered(
          toMessageID(id),
          owner,
          this.clock.now(),
        );

        if (delivered !== null) {
          await this.messages.recordMessageStatus(sessionID, delivered);
        }

        void this.messages.drainSessionInbox(sessionID);
      },
      ackNotice: async (id) => {
        const delivered = await this.store.updateNoticeDelivered(
          toMessageID(id),
          sessionID,
          this.clock.now(),
        );

        if (delivered !== null) {
          await this.messages.recordNoticeStatus(delivered, 'notice-delivered');
        }

        void this.messages.drainSessionInbox(sessionID);
      },
      applyNote: async (payload) => {
        if (parseNote(payload) === null) {
          return false;
        }

        await this.applyNote({ atcId: sessionID, event: 'Note', payload: { ...payload } });

        // A message the bridge settled without an ack, as one the App
        // Server refused, frees the tap for the next one.
        void this.messages.drainSessionInbox(sessionID);

        return true;
      },
      collectUnsettledMessages: async () => {
        const owner = findOwner();

        if (owner === null) {
          return [];
        }

        const unsettled = await this.store.collectUnsettledMessages(owner);

        return unsettled.flatMap((record) =>
          record.status === 'queued' || record.status === 'delivered'
            ? [{ id: record.id, status: record.status }]
            : [],
        );
      },
      log: (line) => {
        this.mgr.log(line);
      },
    };
  }
}
