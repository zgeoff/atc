import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import type { SentNote } from './parse-note';

/**
 * The `SessionNote` event for a note an agent sent mid-turn, addressed by
 * the atc session that sent it. The note's label travels as the event's
 * `kind`.
 */
export function buildSessionNoteEvent(
  sessionID: SessionID,
  note: SentNote,
  sentAt: number,
): EventMsg {
  return {
    v: PROTOCOL_V,
    ev: 'SessionNote',
    s: sessionID,
    kind: note.label,
    text: note.text,
    sentAt,
  };
}
