import { Database } from 'bun:sqlite';

// How a database is opened beyond the journal mode every atc database
// shares. `strict` lets a statement bind a named parameter without its
// prefix. `busyTimeoutMs` makes a write wait that long for another
// process's lock before it fails, and `foreignKeys` enforces the schema's
// foreign keys, cascades included, which SQLite leaves off by default.
interface SQLiteOptions {
  readonly strict?: boolean;
  readonly busyTimeoutMs?: number;
  readonly foreignKeys?: boolean;
}

/**
 * Opens a SQLite database, creating its file when it does not exist, in
 * write-ahead-log mode, so a reader in another process never blocks the
 * writer. It sets only the pragmas the options ask for.
 */
export function openSQLite(path: string, options: SQLiteOptions = {}): Database {
  const sqlite = new Database(path, { create: true, strict: options.strict === true });

  sqlite.run('PRAGMA journal_mode = WAL;');

  if (options.busyTimeoutMs !== undefined) {
    sqlite.run(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs)};`);
  }

  if (options.foreignKeys === true) {
    sqlite.run('PRAGMA foreign_keys = ON;');
  }

  return sqlite;
}
