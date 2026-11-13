import { Database } from 'bun:sqlite';

// The pragmas match the app's opener: a write waits for another process's
// lock, and a revoke's cascade needs foreign keys.
export function openTestAuthDatabase(path: string): Database {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA busy_timeout = 5000;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  return sqlite;
}
