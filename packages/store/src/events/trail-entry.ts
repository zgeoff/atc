import type { AgentSessionID, MessageID, SessionID } from '@atcx/contract';

interface TrailEntryBase {
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly detail: string;
}

interface MessageTrailEntry extends TrailEntryBase {
  readonly kind:
    | 'message-queued'
    | 'message-delivered'
    | 'message-unanswered'
    | 'notice-queued'
    | 'notice-delivered';
  readonly message: MessageID;
}

interface AnsweredTrailEntry extends TrailEntryBase {
  readonly kind: 'message-answered';
  readonly message: MessageID;

  readonly text: string;
}

interface ReportTrailEntry extends TrailEntryBase {
  readonly kind: 'note';
  readonly label: string;

  readonly text: string;

  readonly noteID?: string;
}

export type TrailEntry = MessageTrailEntry | AnsweredTrailEntry | ReportTrailEntry;
