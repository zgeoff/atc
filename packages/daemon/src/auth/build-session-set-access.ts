import type { SessionID } from '@atcx/contract';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import type { TargetAccess, TargetGrant } from './build-target-access-from-grants';
import { intersectTargetAccess } from './intersect-target-access';

// An access that may use one target and reaches the sessions canReach
// admits, wherever each one runs.
export function buildSessionSetAccess(
  grant: TargetGrant,
  canReach: (id: SessionID) => boolean,
): TargetAccess {
  const target = buildTargetAccessFromGrants([grant]);

  const access: TargetAccess = {
    canUse: target.canUse,
    canReach,
    merge: (other) => intersectTargetAccess(access, other),
  };

  return access;
}
