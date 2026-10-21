export interface TargetGrant {
  readonly target: string;
  readonly targetIdentity: string;
}

export interface TargetAccess {
  readonly canUse: (grant: TargetGrant) => boolean;
  readonly merge: (other: TargetAccess) => TargetAccess;
}

export function buildTargetAccessFromGrants(grants: readonly TargetGrant[]): TargetAccess {
  const keyed: ReadonlyMap<string, TargetGrant> = new Map(
    grants.map((grant) => [buildGrantKey(grant), grant]),
  );

  return {
    canUse: (grant) => keyed.has(buildGrantKey(grant)),

    merge: (other) =>
      buildTargetAccessFromGrants([...keyed.values()].filter((grant) => other.canUse(grant))),
  };
}

// the identity is part of the key, so a granted name under another identity is
// outside the grant
function buildGrantKey(grant: TargetGrant): string {
  return JSON.stringify([grant.target, grant.targetIdentity]);
}
