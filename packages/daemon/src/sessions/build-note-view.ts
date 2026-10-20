import { encodeCursor } from '@atc/protocol';
import type { SessionDescriptor } from '@atc/protocol';
import type { StoredNote } from '@atc/store';

export interface NoteView {
  readonly note: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly label: string;
  readonly text: string;
  readonly complete: boolean;
}

export function buildNoteView(
  stored: StoredNote,
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[],
): NoteView {
  // a row can hold an older atc id of a restored session, so an alias holding its agent session
  // id names it; the alias only names it, and a read check still uses the row's own atc id
  const live =
    sessions.find((session) => session.id === stored.atcID) ??
    (stored.agentSessionID === null
      ? undefined
      : aliases.find((session) => session.agentSessionID === stored.agentSessionID));

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
