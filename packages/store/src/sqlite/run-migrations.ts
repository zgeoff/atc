import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { DEFAULT_MIGRATION_TABLE, Migrator } from 'kysely/migration';
import type { MigrationProvider, MigrationResultSet } from 'kysely/migration';
import { collectFleetColumns } from './collect-fleet-columns';
import { MIGRATIONS } from './migrations';
import type { StateStoreSchema } from './state-store-schema';

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

// A database from before the ladder existed is baselined at whichever shape it
// stopped at, so only the steps it is missing run.
export async function runMigrations(db: Kysely<StateStoreSchema>): Promise<void> {
  // A baselined step can land out of order relative to a step that turned
  // out to still be missing beside it, so the ledger the baselining pass
  // writes is not guaranteed to be a contiguous prefix of the ladder.
  const migrator = new Migrator({ db, provider: PROVIDER, allowUnorderedMigrations: true });

  // Baselining writes straight into the ledger, which only the opening step
  // creates. A database with a ledger goes straight to the latest step: the
  // opening step against a full ledger would read as a migration back down.
  if (!(await hasMigrationLedger(db))) {
    const opened = await migrator.migrateTo('001_create_initial_schema');

    requireMigrated(opened);

    await recordLegacyBaseline(db);
  }

  const latest = await migrator.migrateToLatest();

  requireMigrated(latest);
}

async function hasMigrationLedger(db: Kysely<StateStoreSchema>): Promise<boolean> {
  const result = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${DEFAULT_MIGRATION_TABLE}`.execute(
    db,
  );

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

// The migrator's ledger knows no database that carries a later step's outcome
// from before the ladder; recording those steps lets it run only the steps a
// legacy fleet table still needs.
async function recordLegacyBaseline(db: Kysely<StateStoreSchema>): Promise<void> {
  const columns = await collectFleetColumns(db);

  const steps = pickBaselineSteps(columns);

  if (steps.length === 0) {
    return;
  }

  const appliedAt = new Date().toISOString();

  for (const name of steps) {
    await sql`INSERT OR IGNORE INTO ${sql.table(DEFAULT_MIGRATION_TABLE)} (name, timestamp) VALUES (${name}, ${appliedAt})`.execute(
      db,
    );
  }
}

// Each step is judged only by its own column, never an earlier step's, since a
// database from before the ladder can carry any one of these columns without
// the others.
function pickBaselineSteps(columns: ReadonlySet<string>): readonly string[] {
  const steps: string[] = [];

  if (columns.has('agent_session_id')) {
    steps.push('002_rename_fleet_claude_id_to_agent_session_id');
  }

  if (columns.has('pinned')) {
    steps.push('003_add_fleet_pinned');
  }

  if (columns.has('last_attached')) {
    steps.push('004_add_fleet_last_attached');
  }

  if (columns.has('agent')) {
    steps.push('005_add_fleet_agent');
  }

  if (columns.has('exited')) {
    steps.push('006_add_fleet_exited');
  }

  if (columns.has('parent')) {
    steps.push('007_add_fleet_parent');
  }

  return steps;
}
