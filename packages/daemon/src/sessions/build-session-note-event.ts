import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import type { SentNote } from './parse-note';

export function buildSessionNoteEvent(
  sessionID: SessionID,
  note: SentNote,
  sentAt: number,
): EventMsg {
  return {
    version: PROTOCOL_VERSION,
    ev: 'SessionNote',
    sessionID,
    kind: note.label,
    text: note.text,
    sentAt,
  };
}
