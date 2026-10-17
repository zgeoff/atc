import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

export function removePasskey(db: Kysely<MCPAuthSchema>, id: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const removed = await trx.deleteFrom('atc_passkey').where('id', '=', id).executeTakeFirst();

    if (removed.numDeletedRows === 0n) {
      return false;
    }

    // every owner session goes, so no sign-in the removed passkey made carries on
    // to a consent.
    await trx.deleteFrom('session').execute();

    return true;
  });
}
