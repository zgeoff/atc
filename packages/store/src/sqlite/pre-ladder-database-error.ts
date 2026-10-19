// The store migrated nothing: the database holds a fleet table but no
// migration ledger, so no step of the ladder can tell what shape it is in.
export class PreLadderDatabaseError extends Error {
  constructor() {
    super(
      'the state database predates the migration ladder; start atc 4.15.0 against it once to migrate it, then start this release',
    );

    this.name = 'PreLadderDatabaseError';
  }
}
