import type { SessionID } from '@atcx/contract';
import { intersectTargetAccess } from './intersect-target-access';

export interface TargetGrant {
  readonly target: string;
  readonly targetIdentity: string;
}

export interface TargetAccess {
  readonly canUse: (grant: TargetGrant) => boolean;

  // Whether the access reaches the session by its id, for an access bound to
  // a set of sessions rather than to whole trees on its targets; null for an
  // access that reaches a tree when it may use every target in it.
  readonly canReach: ((id: SessionID) => boolean) | null;
  readonly merge: (other: TargetAccess) => TargetAccess;
}

export function buildTargetAccessFromGrants(grants: readonly TargetGrant[]): TargetAccess {
  const keyed: ReadonlyMap<string, TargetGrant> = new Map(
    grants.map((grant) => [buildGrantKey(grant), grant]),
  );

  const access: TargetAccess = {
    canUse: (grant) => keyed.has(buildGrantKey(grant)),
    canReach: null,

    merge: (other) =>
      other.canReach === null
        ? buildTargetAccessFromGrants([...keyed.values()].filter((grant) => other.canUse(grant)))
        : intersectTargetAccess(access, other),
  };

  return access;
}

// the identity is part of the key, so a granted name under another identity is
// outside the grant
function buildGrantKey(grant: TargetGrant): string {
  return JSON.stringify([grant.target, grant.targetIdentity]);
}
