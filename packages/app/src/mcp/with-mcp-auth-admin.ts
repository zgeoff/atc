import { systemClock } from '@atc/core';
import { openATCAuthAdmin } from '@atc/mcp';
import type { MCPAuthAdmin } from '@atc/mcp';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

// Runs one admin command against the authorization database, and closes the
// handle and the connection after it, whether it throws or not.
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
