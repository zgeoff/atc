import type { MCPAuthAdmin } from '@zgeoff/mcp-auth';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { systemClock } from '@zgeoff/std';
import type { Kysely } from 'kysely';
import { openATCAuthAdmin } from '../auth/open-atc-auth-admin';
import type { EventSchema } from '../events/event-schema';
import { openEventDatabase } from '../events/open-event-database';

interface TestEventDatabase {
  readonly db: Kysely<EventSchema>;

  readonly admin: MCPAuthAdmin;
  readonly close: () => Promise<void>;
}

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
