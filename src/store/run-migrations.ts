import { sql } from 'kysely';
import type { Generated, Kysely } from 'kysely';
import { DEFAULT_MIGRATION_TABLE, Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';

interface FleetTable {
  agent_session_id: string;
  name: string;
  cwd: string;
  pinned: number;
  last_attached: number | null;
  agent: string;
  exited: number;
}

interface EventsTable {
  id: Generated<number>;
  ts: string;
  atc_id: string;
  event: string;
  message: string | null;
  session_id: string | null;
}

interface SpawnHistoryTable {
  cwd: string;
  last_spawn: number;
}

interface PrefsTable {
  key: string;
  value: string;
}

/**
 * The state store's schema: what the query builder and the migration
 * ladder both build against.
 */
export interface StateStoreSchema {
  fleet: FleetTable;
  events: EventsTable;
  spawn_history: SpawnHistoryTable;
  prefs: PrefsTable;
}

// Every shape the fleet table has shipped with: the oldest carries only
// agent_session_id under its Claude-era name plus name and cwd, and each
// later step adds one column the daemon grew to depend on. events,
// spawn_history, and prefs have carried one shape since they were added, so
// they need only their initial creation.
const MIGRATIONS: Record<string, Migration> = {
  '001_create_initial_schema': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('fleet')
        .ifNotExists()
        .addColumn('claude_id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('cwd', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('events')
        .ifNotExists()
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('ts', 'text', (c) => c.notNull())
        .addColumn('atc_id', 'text', (c) => c.notNull())
        .addColumn('event', 'text', (c) => c.notNull())
        .addColumn('message', 'text')
        .addColumn('session_id', 'text')
        .execute();

      await db.schema
        .createTable('spawn_history')
        .ifNotExists()
        .addColumn('cwd', 'text', (c) => c.primaryKey())
        .addColumn('last_spawn', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('prefs')
        .ifNotExists()
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute();
    },
  },
  '002_rename_fleet_claude_id_to_agent_session_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').renameColumn('claude_id', 'agent_session_id').execute();
    },
  },
  '003_add_fleet_pinned': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('pinned', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },
  '004_add_fleet_last_attached': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('last_attached', 'integer').execute();
    },
  },
  '005_add_fleet_agent': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('agent', 'text', (c) => c.notNull().defaultTo('claude'))
        .execute();
    },
  },
  '006_add_fleet_exited': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('exited', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },
};

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

/**
 * Brings a state-store database up to the current schema through kysely's
 * `Migrator`, one additive step at a time. A database from before the
 * ladder existed is recognized at whichever shape it stopped at by a
 * baselining pass that records the steps its columns already satisfy, so
 * only what is genuinely missing runs. Nothing here ever drops a column or
 * a row.
 */
export async function runMigrations(db: Kysely<StateStoreSchema>): Promise<void> {
  // A baselined step can land out of order relative to a step that turned
  // out to still be missing beside it, so the ledger the baselining pass
  // writes is not guaranteed to be a contiguous prefix of the ladder.
  const migrator = new Migrator({ db, provider: PROVIDER, allowUnorderedMigrations: true });

  // Baselining writes straight into the ledger, so the ledger has to exist
  // first, and only the opening step can create it. A database that already
  // has a ledger has been baselined once and goes straight to the latest
  // step — running the opening step against a full ledger would read as a
  // request to migrate back down to it.
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

// The migrator's own ledger has no concept of a database that already
// carries a later step's outcome from before the ladder existed. Recording
// those steps here, straight into the ledger, is what lets the migrator run
// only the steps a legacy database's fleet table genuinely still needs.
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

interface ColumnInfoRow {
  name: string;
}

async function collectFleetColumns(db: Kysely<StateStoreSchema>): Promise<ReadonlySet<string>> {
  const result = await sql<ColumnInfoRow>`PRAGMA table_info(fleet)`.execute(db);

  return new Set(result.rows.map((row) => row.name));
}

// Each step is judged solely by whether its own column is already there —
// never by whether an earlier step's column is — because a database from
// before the ladder existed can carry any one of these columns without the
// others.
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

  return steps;
}
