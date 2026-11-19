import type { FleetEntry } from '@atc/store';
import type { Session } from '../sessions/session';

export function isOnEntryTarget(session: Session, entry: FleetEntry): boolean {
  return (
    session.target === (entry.target ?? 'local') &&
    (entry.targetIdentity === undefined || session.targetIdentity === entry.targetIdentity)
  );
}
