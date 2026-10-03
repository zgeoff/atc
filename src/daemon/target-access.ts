/**
 * A target a session runs on, as the name it holds and the identity the
 * session is bound to there.
 */
export interface TargetGrant {
  readonly target: string;
  readonly targetIdentity: string;
}

/**
 * The targets a principal may use, each as a name and an identity: a
 * session on a granted name whose identity differs is outside the grant.
 */
export class TargetAccess {
  private readonly grants: ReadonlyMap<string, TargetGrant>;

  constructor(grants: readonly TargetGrant[]) {
    this.grants = new Map(grants.map((grant) => [buildGrantKey(grant), grant]));
  }

  canUse(grant: TargetGrant): boolean {
    return this.grants.has(buildGrantKey(grant));
  }

  /**
   * The grants both accesses hold, so a principal on a narrowed connection
   * never reaches past the connection.
   */
  merge(other: TargetAccess): TargetAccess {
    return new TargetAccess([...this.grants.values()].filter((grant) => other.canUse(grant)));
  }
}

function buildGrantKey(grant: TargetGrant): string {
  return JSON.stringify([grant.target, grant.targetIdentity]);
}
