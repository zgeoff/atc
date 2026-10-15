import type { SessionID } from '@atc/core';
import type { MessageSender } from '@atc/protocol/wire';
import type { SpawnOptions, SpawnPlan } from './agent-adapter';

/**
 * One inbox message the daemon hands a bridge's tap: its id, the sender's
 * name, who sent it when the daemon knows, and its text.
 */
export interface BridgedMessage {
  readonly id: string;
  readonly from: string;
  readonly sender?: Readonly<MessageSender>;
  readonly text: string;
}

/**
 * The outcome of a message the bridge's session sent, which the daemon hands
 * the tap once the message is answered or unanswered.
 */
export interface BridgedNotice {
  readonly id: string;
  readonly from: string;
  readonly status: 'answered' | 'unanswered';
  readonly answer?: string;
  readonly reason?: string;
}

/**
 * Where the daemon hands a bridge its session's inbox. The daemon hands one
 * item at a time, and the next only after the bridge acks the one before.
 * `close` runs when the daemon takes the tap away, as when the session is
 * removed.
 */
export interface MessageBridgeTap {
  readonly takeMessage: (message: BridgedMessage) => void;
  readonly takeNotice: (notice: BridgedNotice) => void;
  readonly close: () => void;
}

/**
 * A message the session holds that no turn has settled: queued, which no
 * agent took yet, or delivered, which an agent took.
 */
export interface UnsettledMessage {
  readonly id: string;
  readonly status: 'queued' | 'delivered';
}

/**
 * What the daemon gives a bridge for its one session. A tap attaches only
 * once the session lists, and false shows the daemon refused it. An ack
 * marks a queued message delivered, or a notice taken, with or without a
 * tap attached, so a recovery can ack a message before delivery starts. A
 * note payload takes the shapes `atc note`, `atc answer` and
 * `atc unanswered` send, and false shows the daemon read none of them in
 * it.
 */
export interface MessageBridgeHost {
  readonly attachTap: (tap: MessageBridgeTap) => boolean;
  readonly detachTap: (tap: MessageBridgeTap) => void;
  readonly ackMessage: (id: string) => Promise<void>;
  readonly ackNotice: (id: string) => Promise<void>;
  readonly applyNote: (payload: Readonly<Record<string, unknown>>) => Promise<boolean>;
  readonly collectUnsettledMessages: () => Promise<readonly UnsettledMessage[]>;
  readonly log: (line: string) => void;
}

/**
 * A local launch whose agent takes messages through a bridge in the daemon:
 * the session, the folder the harness starts in, the variables it starts
 * with on top of the daemon's own and the names it goes without, the
 * spawn's choices, a folder of the session's own for the bridge's files,
 * and the daemon's side of the bridge.
 */
export interface MessageBridgeRequest {
  readonly session: SessionID;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly withheldEnv: readonly string[];
  readonly options: SpawnOptions;
  readonly dir: string;
  readonly host: MessageBridgeHost;
}

/**
 * A bridge that is ready for its terminal: the plan that starts the
 * terminal against it, the start of delivery, which the daemon calls once
 * the session lists, and the stop, which ends the bridge and everything it
 * started and is safe to call more than once.
 */
export interface MessageBridge {
  readonly plan: SpawnPlan;
  readonly startDelivery: () => void;
  readonly stop: () => Promise<void>;
}
