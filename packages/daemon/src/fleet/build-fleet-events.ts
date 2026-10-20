import type { MessageID } from '@atc/core';
import { encodeCursor } from '@atc/protocol';
import type { SessionDescriptor } from '@atc/protocol';
import type { StoredEvent } from '@atc/store';

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

export function buildFleetEvents(
  rows: readonly StoredEvent[],
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[] = sessions,
): FleetEvent[] {
  return rows.map((row) => {
    // a row's atc id can predate a restore that gave its session a new one, so a session
    // holding the row's agent session id names it when no session holds its atc id
    const live =
      sessions.find((session) => session.id === row.atcID) ??
      (row.agentSessionID === null
        ? undefined
        : aliases.find((session) => session.agentSessionID === row.agentSessionID));

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
