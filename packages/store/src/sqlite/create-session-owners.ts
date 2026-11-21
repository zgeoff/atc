import { randomUUID } from 'node:crypto';
import { systemClock } from '@zgeoff/std';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StateStoreSchema } from './state-store-schema';

export async function createSessionOwners(db: Kysely<StateStoreSchema>): Promise<void> {
  await db.schema
    .createTable('session_owner')
    .ifNotExists()
    .addColumn('session_id', 'text', (column) => column.primaryKey())
    .addColumn('daemon_id', 'text', (column) => column.notNull())
    .addColumn('owner_epoch', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('updated_at', 'integer', (column) => column.notNull())
    .execute();

  await db
    .insertInto('prefs')
    .values({ key: 'daemon_id', value: randomUUID() })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();

  await sql`
    INSERT OR IGNORE INTO session_owner (session_id, daemon_id, updated_at)
    SELECT fleet.session_id, prefs.value, ${systemClock.now()}
    FROM fleet JOIN prefs ON prefs.key = 'daemon_id'
  `.execute(db);
}
