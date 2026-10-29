import type { TargetAccess } from './build-target-access-from-grants';

// Each check of the result passes only when both accesses pass it.
export function intersectTargetAccess(left: TargetAccess, right: TargetAccess): TargetAccess {
  const leftReach = left.canReach;
  const rightReach = right.canReach;

  const access: TargetAccess = {
    canUse: (grant) => left.canUse(grant) && right.canUse(grant),
    canReach:
      leftReach === null && rightReach === null
        ? null
        : (id) => (leftReach?.(id) ?? true) && (rightReach?.(id) ?? true),
    merge: (other) => intersectTargetAccess(access, other),
  };

  return access;
}
