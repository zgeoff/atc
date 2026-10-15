import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

interface SessionPasskey {
  // The owner session a passkey sign-in just created.
  readonly sessionID: string;

  // The passkey whose assertion signed the owner in.
  readonly passkeyID: string;
}

/**
 * Whether the owner session a passkey sign-in created may carry on to
 * consent: in one transaction, the passkey that signed and the session both
 * still exist. Otherwise it removes the session and returns false. A
 * passkey removal or reset deletes passkeys and every owner session in one
 * transaction, so whichever commits first, no session outlives it: one that
 * commits before this check makes the check fail, and one that commits after
 * it deletes the session. A transaction that fails, such as one a
 * concurrent write keeps busy, removes the session and returns false.
 */
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
    await db.deleteFrom('session').where('id', '=', check.sessionID).execute();

    return false;
  }
}
