import type { Database } from 'bun:sqlite';
import type { CompiledQuery, Generated, Kysely } from 'kysely';
import { toSQLBindings } from './to-sql-bindings';

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

interface Migration {
  readonly name: string;

  // Whether the target database already carries this step's outcome, so a
  // database from before the ladder existed is recognized at whichever
  // shape it stopped at instead of replaying steps that would fail against
  // columns already there.
  readonly isApplied: (sqlite: Database) => boolean;
  readonly up: (db: Kysely<StateStoreSchema>) => readonly CompiledQuery[];
}

// Every shape the fleet table has shipped with: the oldest carries only
// agent_session_id under its Claude-era name plus name and cwd, and each
// later step adds one column the daemon grew to depend on. events,
// spawn_history, and prefs have carried one shape since they were added, so
// they need only their initial creation.
const MIGRATIONS: readonly Migration[] = [
  {
    name: '001_create_initial_schema',

    // Never skipped by the probe: every statement below is ifNotExists, so
    // evaluating it against a database that already holds some of the four
    // tables creates only the ones that are missing.
    isApplied: () => false,
    up: (db) => [
      db.schema
        .createTable('fleet')
        .ifNotExists()
        .addColumn('claude_id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('cwd', 'text', (c) => c.notNull())
        .compile(),
      db.schema
        .createTable('events')
        .ifNotExists()
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('ts', 'text', (c) => c.notNull())
        .addColumn('atc_id', 'text', (c) => c.notNull())
        .addColumn('event', 'text', (c) => c.notNull())
        .addColumn('message', 'text')
        .addColumn('session_id', 'text')
        .compile(),
      db.schema
        .createTable('spawn_history')
        .ifNotExists()
        .addColumn('cwd', 'text', (c) => c.primaryKey())
        .addColumn('last_spawn', 'integer', (c) => c.notNull())
        .compile(),
      db.schema
        .createTable('prefs')
        .ifNotExists()
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .compile(),
    ],
  },
  {
    name: '002_rename_fleet_claude_id_to_agent_session_id',
    isApplied: (sqlite) => hasColumn(sqlite, 'fleet', 'agent_session_id'),
    up: (db) => [
      db.schema.alterTable('fleet').renameColumn('claude_id', 'agent_session_id').compile(),
    ],
  },
  {
    name: '003_add_fleet_pinned',
    isApplied: (sqlite) => hasColumn(sqlite, 'fleet', 'pinned'),
    up: (db) => [
      db.schema
        .alterTable('fleet')
        .addColumn('pinned', 'integer', (c) => c.notNull().defaultTo(0))
        .compile(),
    ],
  },
  {
    name: '004_add_fleet_last_attached',
    isApplied: (sqlite) => hasColumn(sqlite, 'fleet', 'last_attached'),
    up: (db) => [db.schema.alterTable('fleet').addColumn('last_attached', 'integer').compile()],
  },
  {
    name: '005_add_fleet_agent',
    isApplied: (sqlite) => hasColumn(sqlite, 'fleet', 'agent'),
    up: (db) => [
      db.schema
        .alterTable('fleet')
        .addColumn('agent', 'text', (c) => c.notNull().defaultTo('claude'))
        .compile(),
    ],
  },
  {
    name: '006_add_fleet_exited',
    isApplied: (sqlite) => hasColumn(sqlite, 'fleet', 'exited'),
    up: (db) => [
      db.schema
        .alterTable('fleet')
        .addColumn('exited', 'integer', (c) => c.notNull().defaultTo(0))
        .compile(),
    ],
  },
];

/**
 * Brings a state-store database up to the current schema, one additive
 * migration at a time, tracked in a ledger table. A fresh database runs
 * every migration from empty; a database from an older schema runs only
 * the ones its columns are still missing. Nothing here ever drops a column
 * or a row.
 */
export function runMigrations(sqlite: Database, db: Kysely<StateStoreSchema>): void {
  sqlite.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const apply = sqlite.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (hasMigrationRun(sqlite, migration.name)) {
        continue;
      }

      if (!migration.isApplied(sqlite)) {
        for (const compiled of migration.up(db)) {
          sqlite.run(compiled.sql, toSQLBindings(compiled.parameters));
        }
      }

      recordMigration(sqlite, migration.name);
    }
  });

  apply();
}

function hasColumn(sqlite: Database, table: string, column: string): boolean {
  return sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

function hasMigrationRun(sqlite: Database, name: string): boolean {
  return (
    sqlite
      .query<{ name: string }, [string]>('SELECT name FROM schema_migrations WHERE name = ?1')
      .get(name) !== null
  );
}

function recordMigration(sqlite: Database, name: string): void {
  sqlite
    .query('INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)')
    .run(name, new Date().toISOString());
}
