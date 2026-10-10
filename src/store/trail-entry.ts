import type { AgentSessionID } from '../shared/agent-session-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';

interface TrailEntryBase {
  // Epoch ms the status change or note happened.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly detail: string;
}

interface MessageTrailEntry extends TrailEntryBase {
  readonly kind: 'message-queued' | 'message-delivered' | 'message-answered';
  readonly message: MessageID;
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

/**
 * One message status change or session note as the event trail holds it,
 * beside the hook events.
 */
export type TrailEntry = MessageTrailEntry | ReportTrailEntry;
