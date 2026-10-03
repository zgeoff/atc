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

  // The report label on a report event.
  readonly label?: string;
}

export function buildFleetEvents(
  rows: readonly StoredEvent[],
  sessions: readonly SessionDescriptor[],
): FleetEvent[] {
  return rows.map((row) => {
    // Rows written before atc session ids stayed stable across restores
    // carry an earlier atc id, so the agent session id links them when no
    // session holds the atc id.
    const live =
      sessions.find((s) => s.id === row.atcID) ??
      (row.agentSessionID === null
        ? undefined
        : sessions.find((s) => s.agentSessionID === row.agentSessionID));

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
