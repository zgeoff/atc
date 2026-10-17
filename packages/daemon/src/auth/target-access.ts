export interface TargetGrant {
  readonly target: string;
  readonly targetIdentity: string;
}

export class TargetAccess {
  private readonly grants: ReadonlyMap<string, TargetGrant>;

  constructor(grants: readonly TargetGrant[]) {
    this.grants = new Map(grants.map((grant) => [buildGrantKey(grant), grant]));
  }

  canUse(grant: TargetGrant): boolean {
    return this.grants.has(buildGrantKey(grant));
  }

  merge(other: TargetAccess): TargetAccess {
    return new TargetAccess([...this.grants.values()].filter((grant) => other.canUse(grant)));
  }
}

// the identity is part of the key, so a granted name under another identity is
// outside the grant
function buildGrantKey(grant: TargetGrant): string {
  return JSON.stringify([grant.target, grant.targetIdentity]);
}
