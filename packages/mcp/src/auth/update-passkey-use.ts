import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

interface PasskeyUse {
  readonly id: string;

  // The counter the verification read, which the passkey must still hold,
  // so a passkey removed during the verification, or a concurrent assertion
  // that stored a newer counter, makes this use fail.
  readonly counter: number;
  readonly newCounter: number;

  // Epoch milliseconds, stamped as the passkey's last use.
  readonly now: number;
}

export async function updatePasskeyUse(
  db: Kysely<MCPAuthSchema>,
  use: PasskeyUse,
): Promise<boolean> {
  const stored = await db
    .updateTable('atc_passkey')
    .set({ counter: use.newCounter, last_used_at: new Date(use.now).toISOString() })
    .where('id', '=', use.id)
    .where('counter', '=', use.counter)
    .executeTakeFirst();

  return stored.numUpdatedRows > 0n;
}
