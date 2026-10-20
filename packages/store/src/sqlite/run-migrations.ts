import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { DEFAULT_MIGRATION_TABLE, Migrator } from 'kysely/migration';
import type { MigrationProvider, MigrationResultSet } from 'kysely/migration';
import { MIGRATIONS } from './migrations';
import { PreLadderDatabaseError } from './pre-ladder-database-error';
import type { StateStoreSchema } from './state-store-schema';

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

// A database without a migration ledger is new when it holds no fleet table,
// and is refused when it holds one, since no step can tell its shape.
export async function runMigrations(db: Kysely<StateStoreSchema>): Promise<void> {
  const hasLedger = await probeTable(db, DEFAULT_MIGRATION_TABLE);
  const hasFleet = await probeTable(db, 'fleet');

  if (!hasLedger && hasFleet) {
    throw new PreLadderDatabaseError();
  }

  // A ledger can record its steps out of timestamp order, so the migrator
  // checks only that every step it records is one the ladder holds.
  const migrator = new Migrator({ db, provider: PROVIDER, allowUnorderedMigrations: true });

  const latest = await migrator.migrateToLatest();

  requireMigrated(latest);
}

async function probeTable(db: Kysely<StateStoreSchema>, name: string): Promise<boolean> {
  const result =
    await sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);

  return result.rows.length > 0;
}

function requireMigrated(result: MigrationResultSet): void {
  if (result.error === undefined) {
    return;
  }

  if (result.error instanceof Error) {
    throw result.error;
  }

  throw new Error('kysely migration failed', { cause: result.error });
}
