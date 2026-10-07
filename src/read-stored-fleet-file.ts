import { Database } from 'bun:sqlite';
import type { StoredRow } from './read-stored-rows';

/**
 * Reads the stored fleet rows straight from the state database, read-only,
 * for a daemon whose protocol this build cannot speak. Only the columns
 * every shipped schema since exit tracking holds are read, so an older
 * daemon's database reads without a migration. On a schema that records
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

    if (!columns.has('session_id')) {
      return null;
    }

    const hasOwners =
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_owner'",
        )
        .get() !== null;

    const exited = columns.has('exited') ? 'fleet.exited' : '0';

    const owned = hasOwners
      ? " WHERE fleet.session_id IN (SELECT session_id FROM session_owner WHERE daemon_id = (SELECT value FROM prefs WHERE key = 'daemon_id'))"
      : '';

    const rows = db
      .query<{ session_id: string; name: string | null; exited: number | null }, []>(
        `SELECT fleet.session_id, fleet.name, ${exited} AS exited FROM fleet${owned} ORDER BY fleet.rowid`,
      )
      .all();

    return rows.map((row) => ({
      id: row.session_id,
      name: row.name ?? row.session_id,
      exited: row.exited === 1,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
