import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import { truncateDetail } from '../shared/truncate-detail';
import type { TrailEntry } from '../store/trail-entry';
import type { SentNote } from './parse-note';

/**
 * The trail entry for one note a session reported, carrying its label, its
 * text and a preview of it, and the id its reporter gave it, when it gave
 * one.
 */
export function buildNoteTrailEntry(
  sessionID: SessionID,
  agentSessionID: AgentSessionID | undefined,
  note: Readonly<SentNote>,
  sentAt: number,
  noteID?: string,
): TrailEntry {
  return {
    at: sentAt,
    atcID: sessionID,
    agentSessionID: agentSessionID ?? null,
    kind: 'note',
    label: note.label,
    detail: truncateDetail(note.text),
    text: note.text,
    ...(noteID === undefined ? {} : { noteID }),
  };
}
