import type { SessionID } from '@atcx/contract';
import type { MessageSender } from '@atcx/contract/light';
import type { SpawnOptions, SpawnPlan } from '../agent-adapter';

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

export interface MessageBridgeTap {
  readonly takeMessage: (message: BridgedMessage) => void;
  readonly takeNotice: (notice: BridgedNotice) => void;
  readonly close: () => void;
}

export interface UnsettledMessage {
  readonly id: string;
  readonly status: 'queued' | 'delivered';
}

export interface MessageBridgeHost {
  readonly attachTap: (tap: MessageBridgeTap) => boolean;
  readonly detachTap: (tap: MessageBridgeTap) => void;

  readonly ackMessage: (id: string) => Promise<void>;
  readonly ackNotice: (id: string) => Promise<void>;

  readonly applyNote: (payload: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly readUnsettledMessages: () => Promise<readonly UnsettledMessage[]>;
  readonly log: (line: string) => void;
}

export interface MessageBridgeRequest {
  readonly session: SessionID;
  readonly cwd: string;

  readonly env: Readonly<Record<string, string>>;
  readonly withheldEnv: readonly string[];
  readonly options: SpawnOptions;

  readonly directory: string;
  readonly host: MessageBridgeHost;
}

export interface MessageBridge {
  readonly plan: SpawnPlan;

  readonly startDelivery: () => void;

  readonly updateThread: (thread: string) => void;

  readonly stop: () => Promise<void>;
}
