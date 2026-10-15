import type { AgentSessionID, SessionID } from '@atc/core';
import { truncateDetail } from '@atc/core';
import type { TrailEntry } from '@atc/store';
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
