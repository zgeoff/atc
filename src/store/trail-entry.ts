import type { AgentSessionID } from '../shared/agent-session-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';

interface TrailEntryBase {
  // Epoch ms the status change or report happened.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly detail: string;
}

interface MessageTrailEntry extends TrailEntryBase {
  readonly kind: 'message-accepted' | 'message-delivered' | 'message-answered';
  readonly message: MessageID;
}

interface ReportTrailEntry extends TrailEntryBase {
  readonly kind: 'report';
  readonly label: string;
}

/**
 * One message status change or session report as the event trail holds it,
 * beside the hook events.
 */
export type TrailEntry = MessageTrailEntry | ReportTrailEntry;
