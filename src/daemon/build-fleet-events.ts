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
  rows: readonly StoredEvent[], // oxlint-disable-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
  sessions: readonly SessionDescriptor[],
): FleetEvent[] {
  return rows.map((row) => {
    // A restore re-mints atc ids, so the agent session id is the stable link.
    const live =
      (row.agentSessionID === null
        ? undefined
        : sessions.find((s) => s.agentSessionID === row.agentSessionID)) ??
      sessions.find((s) => s.id === row.atcID);

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
