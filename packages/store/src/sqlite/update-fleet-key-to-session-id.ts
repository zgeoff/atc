import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { ColumnInfoRow } from './collect-fleet-columns';
import type { StateStoreSchema } from './state-store-schema';

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
export async function updateFleetKeyToSessionID(db: Kysely<StateStoreSchema>): Promise<void> {
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
