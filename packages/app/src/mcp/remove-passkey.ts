import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

/**
 * Removes one enrolled passkey and every owner session, so no sign-in it
 * made carries on to a consent. Grants and their tokens stay. Returns false
 * for an unknown passkey id.
 */
export function removePasskey(db: Kysely<MCPAuthSchema>, id: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const removed = await trx.deleteFrom('atc_passkey').where('id', '=', id).executeTakeFirst();

    if (removed.numDeletedRows === 0n) {
      return false;
    }

    await trx.deleteFrom('session').execute();

    return true;
  });
}
