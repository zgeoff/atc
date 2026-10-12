import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * Runs the callback inside a `BEGIN IMMEDIATE` transaction, which takes the
 * write lock up front, commits when the callback returns, and rolls back and
 * rethrows when it throws. SQLite takes DDL inside such a transaction even
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
    await sql`ROLLBACK`.execute(db);

    throw error;
  }
}
