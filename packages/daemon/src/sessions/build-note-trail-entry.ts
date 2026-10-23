import type { AgentSessionID, SessionID } from '@atc/core';
import { truncateDetail } from '@atc/core';
import type { TrailEntry } from '@atc/store';
import type { SentNote } from './parse-note';

interface BuildNoteTrailEntryOptions {
  readonly sessionID: SessionID;
  readonly agentSessionID: AgentSessionID | undefined;
  readonly note: Readonly<SentNote>;
  readonly sentAt: number;
  readonly noteID?: string | undefined;
}

export function buildNoteTrailEntry(options: BuildNoteTrailEntryOptions): TrailEntry {
  return {
    at: options.sentAt,
    atcID: options.sessionID,
    agentSessionID: options.agentSessionID ?? null,
    kind: 'note',
    label: options.note.label,
    detail: truncateDetail(options.note.text),
    text: options.note.text,
    ...(options.noteID === undefined ? {} : { noteID: options.noteID }),
  };
}
