import { encodeCursor } from '../protocol/encode-cursor';
import type { StoredEvent } from '../store/state-store';
import type { SessionDescriptor } from './sessions';

export interface FleetEvent {
  readonly cursor: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly kind: string;
  readonly detail: string | null;
}

export function buildFleetEvents(
  rows: readonly StoredEvent[],
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
    };
  });
}
