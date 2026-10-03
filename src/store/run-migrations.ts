import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Generated, Kysely } from 'kysely';
import { DEFAULT_MIGRATION_TABLE, Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';
import type { IdempotencyState } from './idempotency-record';
import type { MessageStatus } from './message-record';
import type { MaterializationPhase } from './workspace-materialization';

interface FleetTable {
  session_id: string;
  agent_session_id: string | null;
  name: string;
  cwd: string;
  pinned: number;
  last_attached: number | null;
  agent: string;
  exited: number;
  parent_session_id: string | null;
  prompt: string | null;
  result: string | null;
  transcript_path: string | null;
  model: string | null;
  effort: string | null;
  target: string | null;
  target_identity: string | null;

  // What the operator asked of the session's harness: null keeps it
  // running, `sleep` keeps its host asleep, and `stop` leaves it ended.
  desired: string | null;

  // The session whose host this session's harness runs on: its own id, or
  // its parent's when the two share one host. Null for a row from before
  // hosts were recorded, which runs on its own.
  host_key: string | null;
}

interface EventsTable {
  id: Generated<number>;
  ts: string;
  atc_id: string;
  event: string;
  message: string | null;
  session_id: string | null;
  kind: string | null;
  detail: string | null;
}

interface SpawnHistoryTable {
  cwd: string;
  last_spawn: number;
}

interface PrefsTable {
  key: string;
  value: string;
}

// Which daemon owns each persisted session, and under which ownership
// epoch. A write from a daemon whose epoch is behind the stored one is
// stale and rejected.
interface SessionOwnerTable {
  session_id: string;
  daemon_id: string;
  owner_epoch: Generated<number>;
  updated_at: number;
}

// One idempotency key per principal and operation: the hash of the payload
// it first arrived with, where the keyed effect stands, and the effect it
// names. A key whose outcome is unknown never expires, so a retry of it can
// never start a fresh effect.
interface IdempotencyTable {
  principal: string;
  operation: string;
  key: string;
  payload_hash: string;
  state: IdempotencyState;
  effect_ref: string;
  result: string | null;
  created_at: number;
  updated_at: number;

  // The target, and its identity, the completed effect's session was bound
  // to; null for a key completed without one.
  effect_target: string | null;
  effect_target_identity: string | null;
}

// One spawn's workspace on its way to the execution target, keyed by the
// session it is for.
interface WorkspaceMaterializationTable {
  session_id: string;
  target: string;
  dir: string;
  source_kind: 'path' | 'git';
  phase: MaterializationPhase;
  repo_url: string | null;
  sha: string | null;
  ref: string | null;
  error_code: string | null;
  started_at: number;
  updated_at: number;
  materialized_at: number | null;

  // JSON array of the environment variable names every harness the session
  // starts goes without; names only, never their values.
  withheld_env: string | null;
}

interface MessagesTable {
  id: string;
  atc_id: string;
  agent_session_id: string | null;
  sender: string;
  text: string;
  status: MessageStatus;
  sent_at: number;
  delivered_at: number | null;
  answered_at: number | null;
  answer: string | null;

  // The turn whose final reply is the answer; null for a message answered
  // without one.
  turn_id: string | null;
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
  messages: MessagesTable;
  session_owner: SessionOwnerTable;
  idempotency: IdempotencyTable;
  workspace_materialization: WorkspaceMaterializationTable;
}

// Every shape the fleet table has shipped with: the oldest carries only
// agent_session_id under its Claude-era name plus name and cwd, and each
// later step adds one column the daemon grew to depend on, until the
// rebuild that keys the table by the atc session id. events later gains
// columns of its own, as does messages, while spawn_history and prefs have
// carried one shape since they were added.
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
  '007_add_fleet_parent': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('parent', 'text').execute();
    },
  },
  '008_add_fleet_prompt_result_transcript': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('prompt', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('result', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('transcript_path', 'text').execute();
    },
  },
  '009_add_events_kind_detail': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('events').addColumn('kind', 'text').execute();
      await db.schema.alterTable('events').addColumn('detail', 'text').execute();
    },
  },
  '010_add_events_trail_indexes': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createIndex('events_atc_id_ts')
        .ifNotExists()
        .on('events')
        .columns(['atc_id', 'ts'])
        .execute();

      await db.schema
        .createIndex('events_session_id_ts')
        .ifNotExists()
        .on('events')
        .columns(['session_id', 'ts'])
        .execute();

      // Partial, so the trail reads walk only the rows they return. The
      // predicate text must match the reads' filter for SQLite to pick it.
      await sql`CREATE INDEX IF NOT EXISTS events_trail ON events (id) WHERE kind IS NOT NULL AND kind != 'heartbeat'`.execute(
        db,
      );
    },
  },
  '011_create_messages': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('messages')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('atc_id', 'text', (c) => c.notNull())
        .addColumn('agent_session_id', 'text')
        .addColumn('sender', 'text', (c) => c.notNull())
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'integer', (c) => c.notNull())
        .addColumn('delivered_at', 'integer')
        .addColumn('answered_at', 'integer')
        .addColumn('answer', 'text')
        .execute();
    },
  },
  '012_index_messages_by_owner': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createIndex('messages_atc_id_status_sent_at')
        .ifNotExists()
        .on('messages')
        .columns(['atc_id', 'status', 'sent_at'])
        .execute();

      await db.schema
        .createIndex('messages_agent_session_id_status_sent_at')
        .ifNotExists()
        .on('messages')
        .columns(['agent_session_id', 'status', 'sent_at'])
        .execute();
    },
  },
  '013_add_messages_turn_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('messages').addColumn('turn_id', 'text').execute();

      await db.schema
        .createIndex('messages_turn_id')
        .ifNotExists()
        .on('messages')
        .column('turn_id')
        .execute();
    },
  },
  '014_add_fleet_model_effort': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('model', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('effort', 'text').execute();
    },
  },
  '015_rebuild_fleet_keyed_by_session_id': {
    async up(db: Kysely<StateStoreSchema>) {
      // The ledger records this step only after it returns, so a crash in
      // between leaves a rebuilt table behind a ledger that still lacks it.
      const columns = await collectFleetColumns(db);

      if (columns.has('session_id')) {
        return;
      }

      // SQLite takes this DDL inside a transaction even though kysely's
      // adapter declines to open one for it, so the rebuild lands whole or
      // not at all.
      await sql`BEGIN IMMEDIATE`.execute(db);

      try {
        await updateFleetKeyToSessionID(db);

        await sql`COMMIT`.execute(db);
      } catch (error) {
        await sql`ROLLBACK`.execute(db);

        throw error;
      }
    },
  },
  '016_create_session_owner': {
    async up(db: Kysely<StateStoreSchema>) {
      await sql`BEGIN IMMEDIATE`.execute(db);

      try {
        await createSessionOwners(db);

        await sql`COMMIT`.execute(db);
      } catch (error) {
        await sql`ROLLBACK`.execute(db);

        throw error;
      }
    },
  },
  '017_create_idempotency': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('idempotency')
        .ifNotExists()
        .addColumn('principal', 'text', (c) => c.notNull())
        .addColumn('operation', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('payload_hash', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('effect_ref', 'text', (c) => c.notNull())
        .addColumn('result', 'text')
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('updated_at', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('idempotency_pk', ['principal', 'operation', 'key'])
        .execute();

      await db.schema
        .createIndex('idempotency_state_updated_at')
        .ifNotExists()
        .on('idempotency')
        .columns(['state', 'updated_at'])
        .execute();
    },
  },
  '018_add_fleet_target': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('target', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('target_identity', 'text').execute();
    },
  },
  '019_add_idempotency_effect_target': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('idempotency').addColumn('effect_target', 'text').execute();

      await db.schema
        .alterTable('idempotency')
        .addColumn('effect_target_identity', 'text')
        .execute();
    },
  },
  '020_create_workspace_materialization': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('workspace_materialization')
        .ifNotExists()
        .addColumn('session_id', 'text', (c) => c.primaryKey())
        .addColumn('target', 'text', (c) => c.notNull())
        .addColumn('dir', 'text', (c) => c.notNull())
        .addColumn('source_kind', 'text', (c) => c.notNull())
        .addColumn('phase', 'text', (c) => c.notNull())
        .addColumn('repo_url', 'text')
        .addColumn('sha', 'text')
        .addColumn('ref', 'text')
        .addColumn('error_code', 'text')
        .addColumn('started_at', 'integer', (c) => c.notNull())
        .addColumn('updated_at', 'integer', (c) => c.notNull())
        .addColumn('materialized_at', 'integer')
        .addColumn('withheld_env', 'text')
        .execute();
    },
  },
  '021_add_fleet_lifecycle': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('desired', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('host_key', 'text').execute();
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
 * only what is genuinely missing runs. One step rebuilds the fleet table
 * under a new key and carries every row across; no step drops a row.
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

// Mints the store's daemon id when it has none, then records that daemon as
// the owner of every fleet row, at the first ownership epoch.
async function createSessionOwners(db: Kysely<StateStoreSchema>): Promise<void> {
  await db.schema
    .createTable('session_owner')
    .ifNotExists()
    .addColumn('session_id', 'text', (c) => c.primaryKey())
    .addColumn('daemon_id', 'text', (c) => c.notNull())
    .addColumn('owner_epoch', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('updated_at', 'integer', (c) => c.notNull())
    .execute();

  await db
    .insertInto('prefs')
    .values({ key: 'daemon_id', value: randomUUID() })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();

  await sql`
    INSERT OR IGNORE INTO session_owner (session_id, daemon_id, updated_at)
    SELECT fleet.session_id, prefs.value, ${Date.now()}
    FROM fleet JOIN prefs ON prefs.key = 'daemon_id'
  `.execute(db);
}

interface LegacyFleetIDRow {
  old_rowid: number;
  agent_session_id: string | null;
}

// The columns the rebuild writes by name. Any other column a legacy table
// carries moves across untouched, so the rebuild never loses data a step
// outside this ladder added.
const REBUILT_FLEET_COLUMNS: ReadonlySet<string> = new Set([
  'agent_session_id',
  'name',
  'cwd',
  'pinned',
  'last_attached',
  'agent',
  'exited',
  'parent',
  'prompt',
  'result',
  'transcript_path',
  'model',
  'effort',
]);

// Gives every row a minted atc session id and moves the sub-session link
// from the parent's agent session id to the parent's atc session id. A link
// to an agent session id no row holds becomes no link.
async function updateFleetKeyToSessionID(db: Kysely<StateStoreSchema>): Promise<void> {
  const columns = await sql<ColumnInfoRow>`PRAGMA table_info(fleet)`.execute(db);

  const extras = columns.rows.filter((column) => !REBUILT_FLEET_COLUMNS.has(column.name));

  // Keyed by rowid: SQLite lets a text primary key hold NULL, so a legacy
  // row can lack the agent session id the mapping would otherwise key on.
  await sql`CREATE TEMP TABLE fleet_ids (old_rowid INTEGER PRIMARY KEY, agent_session_id TEXT, session_id TEXT NOT NULL)`.execute(
    db,
  );

  const rows =
    await sql<LegacyFleetIDRow>`SELECT rowid AS old_rowid, agent_session_id FROM fleet`.execute(db);

  for (const row of rows.rows) {
    await sql`INSERT INTO fleet_ids (old_rowid, agent_session_id, session_id) VALUES (${row.old_rowid}, ${row.agent_session_id}, ${randomUUID()})`.execute(
      db,
    );
  }

  const extraDefinitions = extras.map(
    (column) => sql`, ${sql.ref(column.name)} ${sql.raw(column.type)}`,
  );

  const extraTargets = extras.map((column) => sql`, ${sql.ref(column.name)}`);
  const extraSources = extras.map((column) => sql`, ${sql.ref(`f.${column.name}`)}`);

  await sql`
    CREATE TABLE fleet_rebuilt (
      session_id TEXT PRIMARY KEY,
      agent_session_id TEXT UNIQUE,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      prompt TEXT,
      result TEXT,
      transcript_path TEXT,
      model TEXT,
      effort TEXT
      ${sql.join(extraDefinitions, sql``)}
    )
  `.execute(db);

  await sql`
    INSERT INTO fleet_rebuilt (
      session_id, agent_session_id, name, cwd, pinned, last_attached, agent, exited,
      parent_session_id, prompt, result, transcript_path, model, effort
      ${sql.join(extraTargets, sql``)}
    )
    SELECT
      ids.session_id, f.agent_session_id, f.name, f.cwd, f.pinned, f.last_attached, f.agent,
      f.exited, parents.session_id, f.prompt, f.result, f.transcript_path, f.model, f.effort
      ${sql.join(extraSources, sql``)}
    FROM fleet f
    JOIN fleet_ids ids ON ids.old_rowid = f.rowid
    LEFT JOIN fleet_ids parents ON parents.agent_session_id = f.parent
  `.execute(db);

  await sql`DROP TABLE fleet`.execute(db);
  await sql`ALTER TABLE fleet_rebuilt RENAME TO fleet`.execute(db);
  await sql`DROP TABLE fleet_ids`.execute(db);
}

interface ColumnInfoRow {
  name: string;
  type: string;
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

  if (columns.has('parent')) {
    steps.push('007_add_fleet_parent');
  }

  return steps;
}
