import type { MCPAuthDatabase } from '@atc/mcp';
import { openSQLite } from '@atc/store/sqlite';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';

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
