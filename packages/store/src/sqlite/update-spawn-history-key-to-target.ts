import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StateStoreSchema } from './state-store-schema';

// The identity of the local target with no options. Every spawn from before
// spawns recorded their target ran there.
const LEGACY_SPAWN_TARGET_IDENTITY = 'local-pty:44136fa355b3678a';

export async function updateSpawnHistoryKeyToTarget(db: Kysely<StateStoreSchema>): Promise<void> {
  await sql`
    CREATE TABLE spawn_history_rebuilt (
      cwd TEXT NOT NULL,
      target TEXT NOT NULL,
      target_identity TEXT NOT NULL,
      last_spawn INTEGER NOT NULL,
      PRIMARY KEY (cwd, target, target_identity)
    )
  `.execute(db);

  await sql`
    INSERT INTO spawn_history_rebuilt (cwd, target, target_identity, last_spawn)
    SELECT cwd, 'local', ${LEGACY_SPAWN_TARGET_IDENTITY}, last_spawn FROM spawn_history
  `.execute(db);

  await sql`DROP TABLE spawn_history`.execute(db);
  await sql`ALTER TABLE spawn_history_rebuilt RENAME TO spawn_history`.execute(db);
}
