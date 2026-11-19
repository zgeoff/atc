import type { AgentSessionID, MessageID, SessionID } from '@atcx/contract';
import type { MessageSender } from '@atcx/contract/light';

export type MessageStatus = 'queued' | 'delivered' | 'answered' | 'unanswered';

export interface MessageRecord {
  readonly id: MessageID;
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;

  readonly from: string;

  readonly sender?: MessageSender;
  readonly text: string;
  readonly status: MessageStatus;
  readonly sentAt: number;
  readonly deliveredAt?: number;
  readonly answeredAt?: number;
  readonly answer?: string;
  readonly unansweredAt?: number;

  readonly unansweredReason?: string;

  readonly turn?: string;

  readonly senderSession?: SessionID;
  readonly noticeQueuedAt?: number;
  readonly noticeDeliveredAt?: number;
}

export interface TurnSibling {
  readonly id: MessageID;
  readonly atcID: SessionID;
}
