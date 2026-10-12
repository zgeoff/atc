import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { MessageID } from '@atc/core/message-id';
import type { SessionID } from '@atc/core/session-id';

export type MessageStatus = 'queued' | 'delivered' | 'answered';

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

  // The turn whose final reply the answer is, when the reporter gave one.
  readonly turn?: string;
}
