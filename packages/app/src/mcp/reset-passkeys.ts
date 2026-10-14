import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

/**
 * Returns browser sign-in to its state before any enrollment: removes every
 * passkey, every unspent enrollment token, and every owner session, so
 * nothing a lost authenticator or an earlier token could do still works.
 * Grants and their tokens stay; revoke them with `atc grants`.
 */
export async function resetPasskeys(db: Kysely<MCPAuthSchema>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('atc_passkey').execute();
    await trx.deleteFrom('atc_enrollment_token').execute();
    await trx.deleteFrom('session').execute();
  });
}
