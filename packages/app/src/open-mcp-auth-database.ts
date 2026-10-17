import { buildSQLiteDialect, openSQLite } from '@atc/store/sqlite';
import type { MCPAuthDatabase } from './mcp/mcp-auth-database';

export function openMCPAuthDatabase(path: string): MCPAuthDatabase {
  // a write waits for another process's lock, since the commands and a running
  // server share the file; the cascades from a client to its tokens and
  // consent need foreign keys
  const sqlite = openSQLite(path, { busyTimeoutMs: 5000, foreignKeys: true });

  return {
    dialect: buildSQLiteDialect(sqlite),
    close: () => {
      sqlite.close();
    },
  };
}
