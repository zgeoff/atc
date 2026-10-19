import { Database } from 'bun:sqlite';
import { requireOpenableSQLitePath } from '../sqlite/register-refused-sqlite-name';
import type { StoredRow } from './read-stored-rows';

// Reads a daemon whose protocol this build cannot speak, straight from its
// database. A database without the session id, the exit status, or the
// ownership table reads as none, like one that will not open.
export function readStoredFleetFile(dbPath: string): StoredRow[] | null {
  // a refused file throws, where a file that will not open reads as none
  requireOpenableSQLitePath(dbPath);

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

    const hasOwners =
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_owner'",
        )
        .get() !== null;

    if (!columns.has('session_id') || !columns.has('exited') || !hasOwners) {
      return null;
    }

    const rows = db
      .query<{ id: string; name: string; exited: number }, []>(
        "SELECT fleet.session_id AS id, fleet.name, fleet.exited FROM fleet WHERE fleet.session_id IN (SELECT session_id FROM session_owner WHERE daemon_id = (SELECT value FROM prefs WHERE key = 'daemon_id')) ORDER BY fleet.rowid",
      )
      .all();

    return rows.map((row) => ({ id: row.id, name: row.name, exited: row.exited === 1 }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
