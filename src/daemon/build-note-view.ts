import { encodeCursor } from '../protocol/encode-cursor';
import type { StoredNote } from '../store/state-store';
import type { SessionDescriptor } from './sessions';

/**
 * One note as `note.get` returns it: the cursor of its event, when it
 * arrived, the session that sent it and that session's name, its label, its
 * text, and whether that text is whole.
 */
export interface NoteView {
  readonly note: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly label: string;
  readonly text: string;
  readonly complete: boolean;
}

/**
 * Builds the view from the sessions that may name it. A row written before
 * atc session ids stayed stable across restores carries an earlier atc id,
 * so a session of `aliases` that holds its agent session id names it when
 * no session holds the atc id. The alias only names the note: whoever
 * checks who may read it checks the row's own atc id.
 */
export function buildNoteView(
  stored: StoredNote,
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[],
): NoteView {
  const live =
    sessions.find((s) => s.id === stored.atcID) ??
    (stored.agentSessionID === null
      ? undefined
      : aliases.find((s) => s.agentSessionID === stored.agentSessionID));

  return {
    note: encodeCursor({ kind: 'events', id: stored.id }),
    at: stored.at,
    session: live?.id ?? stored.atcID,
    name: live?.name ?? null,
    label: stored.label,
    text: stored.text,
    complete: stored.complete,
  };
}
