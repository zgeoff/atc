import { Database } from 'bun:sqlite';
import { requireOpenableSQLitePath } from './register-refused-sqlite-name';

interface SQLiteOptions {
  // Binds a named parameter without its prefix.
  readonly strict?: boolean;

  // How long a write waits for another process's lock before it fails.
  readonly busyTimeoutMs?: number;

  // Enforces foreign keys, cascades included, which SQLite leaves off by default.
  readonly foreignKeys?: boolean;
}

export function openSQLite(path: string, options: SQLiteOptions = {}): Database {
  requireOpenableSQLitePath(path);

  const sqlite = new Database(path, { create: true, strict: options.strict === true });

  // A reader in another process never blocks the writer.
  sqlite.run('PRAGMA journal_mode = WAL;');

  if (options.busyTimeoutMs !== undefined) {
    sqlite.run(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs)};`);
  }

  if (options.foreignKeys === true) {
    sqlite.run('PRAGMA foreign_keys = ON;');
  }

  return sqlite;
}
