import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { MessageID } from '@atc/core/message-id';
import type { SessionID } from '@atc/core/session-id';

export type MessageStatus = 'queued' | 'delivered' | 'answered' | 'unanswered';

export interface MessageRecord {
  readonly id: MessageID;
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;
  readonly from: string;
  readonly text: string;
  readonly status: MessageStatus;
  readonly sentAt: number;
  readonly deliveredAt?: number;
  readonly answeredAt?: number;
  readonly answer?: string;
  readonly unansweredAt?: number;

  // One word for why the turn that carried the message ended without an
  // answer: interrupted, error, refusal, or not_started.
  readonly unansweredReason?: string;

  // The turn whose final reply the answer is, or the turn that ended without
  // one, when the reporter gave one.
  readonly turn?: string;

  // The session that sent the message, which takes an answer notice once
  // the message is answered or unanswered; absent for a sender with no
  // inbox.
  readonly senderSession?: SessionID;
  readonly noticeQueuedAt?: number;
  readonly noticeDeliveredAt?: number;
}
