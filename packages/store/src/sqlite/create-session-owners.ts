import { randomUUID } from 'node:crypto';
import { systemClock } from '@atc/core';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StateStoreSchema } from './state-store-schema';

// Mints the store's daemon id when it has none, then records that daemon as
// the owner of every fleet row, at the first ownership epoch.
export async function createSessionOwners(db: Kysely<StateStoreSchema>): Promise<void> {
  await db.schema
    .createTable('session_owner')
    .ifNotExists()
    .addColumn('session_id', 'text', (c) => c.primaryKey())
    .addColumn('daemon_id', 'text', (c) => c.notNull())
    .addColumn('owner_epoch', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('updated_at', 'integer', (c) => c.notNull())
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
