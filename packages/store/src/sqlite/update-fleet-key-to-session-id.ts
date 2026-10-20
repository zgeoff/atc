import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { StateStoreSchema } from './state-store-schema';

const FLEET_ID_ROWS_SCHEMA = z.array(
  z.object({ old_rowid: z.number(), agent_session_id: z.string().nullable() }),
);

// Gives every row a minted atc session id and moves the sub-session link
// from the parent's agent session id to the parent's atc session id. A link
// to an agent session id no row holds becomes no link.
export async function updateFleetKeyToSessionID(db: Kysely<StateStoreSchema>): Promise<void> {
  // Keyed by rowid: SQLite lets a text primary key hold NULL, so a row can
  // lack the agent session id the mapping would otherwise key on.
  await sql`CREATE TEMP TABLE fleet_ids (old_rowid INTEGER PRIMARY KEY, agent_session_id TEXT, session_id TEXT NOT NULL)`.execute(
    db,
  );

  const result = await sql`SELECT rowid AS old_rowid, agent_session_id FROM fleet`.execute(db);

  for (const row of FLEET_ID_ROWS_SCHEMA.parse(result.rows)) {
    await sql`INSERT INTO fleet_ids (old_rowid, agent_session_id, session_id) VALUES (${row.old_rowid}, ${row.agent_session_id}, ${randomUUID()})`.execute(
      db,
    );
  }

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
    )
  `.execute(db);

  await sql`
    INSERT INTO fleet_rebuilt (
      session_id, agent_session_id, name, cwd, pinned, last_attached, agent, exited,
      parent_session_id, prompt, result, transcript_path, model, effort
    )
    SELECT
      ids.session_id, f.agent_session_id, f.name, f.cwd, f.pinned, f.last_attached, f.agent,
      f.exited, parents.session_id, f.prompt, f.result, f.transcript_path, f.model, f.effort
    FROM fleet f
    JOIN fleet_ids ids ON ids.old_rowid = f.rowid
    LEFT JOIN fleet_ids parents ON parents.agent_session_id = f.parent
  `.execute(db);

  await sql`DROP TABLE fleet`.execute(db);
  await sql`ALTER TABLE fleet_rebuilt RENAME TO fleet`.execute(db);
  await sql`DROP TABLE fleet_ids`.execute(db);
}
