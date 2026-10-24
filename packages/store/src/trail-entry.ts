import type { AgentSessionID, MessageID, SessionID } from '@atcx/contract';

interface TrailEntryBase {
  // Epoch ms the status change or note happened.
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

  // The message's whole answer, which the detail previews.
  readonly text: string;
}

interface ReportTrailEntry extends TrailEntryBase {
  readonly kind: 'note';
  readonly label: string;

  // The note's whole text, which the detail previews.
  readonly text: string;

  // The id a remote session's reporter gave the note, so a resent
  // note is stored once; absent for a note that carries none.
  readonly noteID?: string;
}

export type TrailEntry = MessageTrailEntry | AnsweredTrailEntry | ReportTrailEntry;
