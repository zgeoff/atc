import { encodeCursor } from '../protocol/encode-cursor';
import type { MessageID } from '../shared/message-id';
import type { StoredEvent } from '../store/state-store';
import type { SessionDescriptor } from './sessions';

export interface FleetEvent {
  readonly cursor: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly kind: string;
  readonly detail: string | null;

  // The message id on a message status event, for message.get.
  readonly message?: MessageID;

  // The note label on a note event.
  readonly label?: string;
}

/**
 * Builds the events from the sessions that may name them. Rows written
 * before atc session ids stayed stable across restores carry an earlier atc
 * id, so a session of `aliases` that holds a row's agent session id names
 * it when no session holds the atc id; every session that may name a row
 * may alias it unless the caller gives fewer.
 */
export function buildFleetEvents(
  rows: readonly StoredEvent[],
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[] = sessions,
): FleetEvent[] {
  return rows.map((row) => {
    const live =
      sessions.find((s) => s.id === row.atcID) ??
      (row.agentSessionID === null
        ? undefined
        : aliases.find((s) => s.agentSessionID === row.agentSessionID));

    return {
      cursor: encodeCursor({ kind: 'events', id: row.id }),
      at: row.at,
      session: live?.id ?? row.atcID,
      name: live?.name ?? null,
      kind: row.kind,
      detail: row.detail,
      ...(row.message === undefined ? {} : { message: row.message }),
      ...(row.label === undefined ? {} : { label: row.label }),
    };
  });
}
