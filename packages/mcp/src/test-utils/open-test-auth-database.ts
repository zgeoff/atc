import { Database } from 'bun:sqlite';

// The busy timeout makes a write wait for another process's lock instead of failing at once,
// and SQLite leaves foreign keys off per connection, which a revoke's cascade needs on.
export function openTestAuthDatabase(path: string): Database {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA busy_timeout = 5000;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  return sqlite;
}
