import type { SessionID } from '@atc/core';
import type { MessageSender } from '@atc/protocol/wire';
import type { SpawnOptions, SpawnPlan } from './agent-adapter';

export interface BridgedMessage {
  readonly id: string;
  readonly from: string;
  readonly sender?: Readonly<MessageSender>;
  readonly text: string;
}

export interface BridgedNotice {
  readonly id: string;
  readonly from: string;
  readonly status: 'answered' | 'unanswered';
  readonly answer?: string;
  readonly reason?: string;
}

// the daemon hands one item at a time, the next only after the bridge acks or
// settles the one before.
export interface MessageBridgeTap {
  readonly takeMessage: (message: BridgedMessage) => void;
  readonly takeNotice: (notice: BridgedNotice) => void;
  readonly close: () => void;
}

// a message no turn has settled yet.
export interface UnsettledMessage {
  readonly id: string;
  readonly status: 'queued' | 'delivered';
}

export interface MessageBridgeHost {
  // a tap attaches only once the session lists; false shows the daemon
  // refused it.
  readonly attachTap: (tap: MessageBridgeTap) => boolean;
  readonly detachTap: (tap: MessageBridgeTap) => void;

  // an ack works with or without a tap attached, so a recovery can ack a
  // message before delivery starts.
  readonly ackMessage: (id: string) => Promise<void>;
  readonly ackNotice: (id: string) => Promise<void>;

  // takes the payload shapes `atc note`, `atc answer` and `atc unanswered`
  // send; false shows the daemon read none of them in it.
  readonly applyNote: (payload: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly collectUnsettledMessages: () => Promise<readonly UnsettledMessage[]>;
  readonly log: (line: string) => void;
}

export interface MessageBridgeRequest {
  readonly session: SessionID;
  readonly cwd: string;

  // set on top of the daemon's own environment.
  readonly env: Readonly<Record<string, string>>;
  readonly withheldEnv: readonly string[];
  readonly options: SpawnOptions;

  // a folder of the session's own for the bridge's files.
  readonly dir: string;
  readonly host: MessageBridgeHost;
}

export interface MessageBridge {
  readonly plan: SpawnPlan;

  // the daemon calls it once the session lists.
  readonly startDelivery: () => void;

  // the daemon calls it with the session's new agent session id once a hook
  // shows the terminal moved to another conversation.
  readonly updateThread: (thread: string) => void;

  // ends the bridge and everything it started; safe to call more than once.
  readonly stop: () => Promise<void>;
}
