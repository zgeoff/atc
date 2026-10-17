import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function withImmediateTransaction<DB>(
  db: Kysely<DB>,
  writes: () => Promise<void>,
): Promise<void> {
  // SQLite takes DDL inside this transaction though kysely's adapter declines to
  // open one for it, so a table rebuild lands whole or not at all.
  await sql`BEGIN IMMEDIATE`.execute(db);

  try {
    await writes();

    await sql`COMMIT`.execute(db);
  } catch (error) {
    try {
      await sql`ROLLBACK`.execute(db);
    } catch {
      // SQLite rolls a transaction back itself after some failures, such as
      // a full disk, and then refuses this rollback; the first error is the
      // one the caller needs.
    }

    throw error;
  }
}
