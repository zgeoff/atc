import { systemClock } from '@atc/core';
import type { MCPAuthAdmin } from '@zgeoff/mcp-auth';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import type { Kysely } from 'kysely';
import { openATCAuthAdmin } from '../auth/open-atc-auth-admin';
import type { EventSchema } from '../events/event-schema';
import { openEventDatabase } from '../events/open-event-database';

interface TestEventDatabase {
  readonly db: Kysely<EventSchema>;

  // The package's admin handle on the same database, which adds the clients
  // whose names a delivery reads.
  readonly admin: MCPAuthAdmin;
  readonly close: () => Promise<void>;
}

// An in-memory authorization database with atc's event tables beside the
// package's own.
export async function openTestEventDatabase(): Promise<TestEventDatabase> {
  const sqlite = createTestDatabase();

  const admin = await openATCAuthAdmin(sqlite, systemClock);

  const db = openEventDatabase(sqlite);

  return {
    db,
    admin,
    close: async () => {
      await db.destroy();
      await admin.close();

      sqlite.close();
    },
  };
}
