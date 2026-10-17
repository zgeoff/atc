import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

interface SessionPasskey {
  // The owner session a passkey sign-in just created.
  readonly sessionID: string;

  // The passkey whose assertion signed the owner in.
  readonly passkeyID: string;
}

export async function verifySessionPasskey(
  db: Kysely<MCPAuthSchema>,
  check: SessionPasskey,
): Promise<boolean> {
  try {
    return await db.transaction().execute(async (trx) => {
      const passkey = await trx
        .selectFrom('atc_passkey')
        .select('id')
        .where('id', '=', check.passkeyID)
        .executeTakeFirst();

      const session = await trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', check.sessionID)
        .executeTakeFirst();

      if (passkey !== undefined && session !== undefined) {
        return true;
      }

      await trx.deleteFrom('session').where('id', '=', check.sessionID).execute();

      return false;
    });
  } catch {
    // a transaction that fails, such as one a concurrent write keeps busy, still
    // removes the session.
    await db.deleteFrom('session').where('id', '=', check.sessionID).execute();

    return false;
  }
}
