import type { FleetEntry } from '@atc/store';
import type { Session } from '../sessions/session';

export function isSameSession(session: Session, entry: FleetEntry): boolean {
  return (
    session.id === entry.sessionID ||
    (entry.agentSessionID !== undefined && session.agentSessionID === entry.agentSessionID)
  );
}
