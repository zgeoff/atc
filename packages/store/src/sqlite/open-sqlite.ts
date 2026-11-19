import { Database } from 'bun:sqlite';
import { requireOpenableSQLitePath } from './register-refused-sqlite-name';

interface SQLiteOptions {
  readonly strict?: boolean;

  readonly busyTimeoutMs?: number;

  // SQLite leaves foreign keys off by default.
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
