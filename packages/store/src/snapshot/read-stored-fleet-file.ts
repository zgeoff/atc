import { Database } from 'bun:sqlite';
import type { StoredRow } from './read-stored-rows';

/**
 * Reads the stored fleet rows straight from the state database, read-only,
 * for a daemon whose protocol this build cannot speak. Each column is read
 * under the name the file's schema gives it, and one the schema lacks reads
 * as its default, so an older daemon's database reads without a migration. On a schema that records
 * session ownership, only the rows this state directory's daemon owns are
 * read, as the daemon's own fleet list reads them. Returns null when the
 * file is missing or cannot be read.
 */
export function readStoredFleetFile(dbPath: string): StoredRow[] | null {
  let db: Database;

  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(fleet)')
        .all()
        .map((column) => column.name),
    );

    // Before the store keyed rows by atc session id, a row held only the
    // agent's session id, under one of two names; the new daemon assigns
    // the atc id as it migrates, so such a row is matched by the agent's id.
    const agentColumn = ['agent_session_id', 'claude_id'].find((name) => columns.has(name));

    if (!columns.has('session_id') && agentColumn === undefined) {
      return null;
    }

    const id = columns.has('session_id') ? 'fleet.session_id' : `fleet.${agentColumn}`;
    const agentID = agentColumn === undefined ? 'NULL' : `fleet.${agentColumn}`;
    const exited = columns.has('exited') ? 'fleet.exited' : '0';

    const hasOwners =
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_owner'",
        )
        .get() !== null;

    const owned = hasOwners
      ? " WHERE fleet.session_id IN (SELECT session_id FROM session_owner WHERE daemon_id = (SELECT value FROM prefs WHERE key = 'daemon_id'))"
      : '';

    const rows = db
      .query<
        { id: string; agent_session_id: string | null; name: string | null; exited: number | null },
        []
      >(
        `SELECT ${id} AS id, ${agentID} AS agent_session_id, fleet.name, ${exited} AS exited FROM fleet${owned} ORDER BY fleet.rowid`,
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? row.id,
      exited: row.exited === 1,
      agentSessionID: row.agent_session_id,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
