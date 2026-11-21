import { openATCAuthAdmin } from '@atc/mcp';
import type { MCPAuthAdmin } from '@atc/mcp';
import { systemClock } from '@zgeoff/std';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

export async function withMCPAuthAdmin<Result>(
  dbPath: string,
  run: (admin: MCPAuthAdmin) => Promise<Result>,
): Promise<Result> {
  const sqlite = openMCPAuthDatabase(dbPath);

  try {
    const admin = await openATCAuthAdmin(sqlite, systemClock);

    try {
      return await run(admin);
    } finally {
      await admin.close();
    }
  } finally {
    sqlite.close();
  }
}
