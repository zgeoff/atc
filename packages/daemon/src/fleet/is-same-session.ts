import type { FleetEntry } from '@atc/store';
import type { Session } from '../sessions/session';

// A stored entry matches a listed session by its atc session id, or by its
// agent session id when a listed session resumed the same agent session.
export function isSameSession(session: Session, entry: FleetEntry): boolean {
  return (
    session.id === entry.sessionID ||
    (entry.agentSessionID !== undefined && session.agentSessionID === entry.agentSessionID)
  );
}
