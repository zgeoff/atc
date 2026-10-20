import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { SentNote } from './parse-note';

export function buildSessionNoteEvent(
  sessionID: SessionID,
  note: SentNote,
  sentAt: number,
): EventMsg {
  return {
    version: PROTOCOL_V,
    ev: 'SessionNote',
    sessionID,
    kind: note.label,
    text: note.text,
    sentAt,
  };
}
