import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
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
