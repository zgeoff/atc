import type { AgentSessionID } from '../shared/agent-session-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';

export type MessageStatus = 'accepted' | 'delivered' | 'answered';

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
}

// Which session a message belongs to: the atc id it was sent to, or the
// agent session id that survives a restore's re-minted atc id.
export interface MessageOwner {
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;
}
