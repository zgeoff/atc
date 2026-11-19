import type { FleetEntry } from '@atc/store';
import type { Session } from '../sessions/session';

// Whether a listed session runs on the target and identity a stored entry
// was bound to. An entry without a target was bound to the `local` target,
// and one without an identity matches any identity of its target.
export function isOnEntryTarget(session: Session, entry: FleetEntry): boolean {
  return (
    session.target === (entry.target ?? 'local') &&
    (entry.targetIdentity === undefined || session.targetIdentity === entry.targetIdentity)
  );
}
