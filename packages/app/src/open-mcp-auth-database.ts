import { buildSQLiteDialect } from '@atc/store/sqlite/build-sqlite-dialect';
import { openSQLite } from '@atc/store/sqlite/open-sqlite';
import type { MCPAuthDatabase } from './mcp/mcp-auth-database';

/**
 * Opens the authorization server's SQLite database at `path`. A write waits
 * for another process's lock before it fails, since `atc clients` and a
 * running server share the file, and foreign keys are on, because the
 * schema's cascades from a client to its tokens and consent need them.
 */
export function openMCPAuthDatabase(path: string): MCPAuthDatabase {
  const sqlite = openSQLite(path, { busyTimeoutMs: 5000, foreignKeys: true });

  return {
    dialect: buildSQLiteDialect(sqlite),
    close: () => {
      sqlite.close();
    },
  };
}
