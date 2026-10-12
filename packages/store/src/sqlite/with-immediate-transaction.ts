import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * Runs the callback inside a `BEGIN IMMEDIATE` transaction, which takes the
 * write lock up front, commits when the callback returns, and rolls back and
 * rethrows the callback's error when it throws. SQLite takes DDL inside such a transaction even
 * though kysely's adapter declines to open one for it, so a table rebuild
 * lands whole or not at all.
 */
export async function withImmediateTransaction<DB>(
  db: Kysely<DB>,
  writes: () => Promise<void>,
): Promise<void> {
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
