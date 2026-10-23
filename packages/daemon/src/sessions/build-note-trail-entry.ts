import { truncateDetail } from '@atc/core';
import type { TrailEntry } from '@atc/store';
import type { AgentSessionID, SessionID } from '@atcx/contract';
import type { SentNote } from './parse-note';

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
