import { Database } from 'bun:sqlite';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import type { MCPAuthDatabase } from '../auth/mcp-auth-database';

// The pragmas match the app's opener: a write waits for another process's
// lock, and the cascades from a client to its tokens need foreign keys.
export function openTestAuthDatabase(path: string): MCPAuthDatabase {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA busy_timeout = 5000;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  return {
    dialect: buildSQLiteDialect(sqlite),
    close: () => {
      sqlite.close();
    },
  };
}
