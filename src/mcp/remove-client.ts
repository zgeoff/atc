import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './types';

/**
 * Removes a client and everything it holds: its access and refresh tokens,
 * its consent, and when its grants were last used. Returns false for an
 * unknown client id.
 */
export function removeClient(db: Kysely<MCPAuthSchema>, clientID: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const grants = await trx
      .selectFrom('oauthRefreshToken')
      .select('authorizationCodeId')
      .where('clientId', '=', clientID)
      .execute();

    const grantIDs = grants.flatMap((grant) =>
      grant.authorizationCodeId === null ? [] : [grant.authorizationCodeId],
    );

    if (grantIDs.length > 0) {
      await trx.deleteFrom('atc_grant_use').where('grant_id', 'in', grantIDs).execute();
    }

    await trx.deleteFrom('oauthAccessToken').where('clientId', '=', clientID).execute();
    await trx.deleteFrom('oauthRefreshToken').where('clientId', '=', clientID).execute();
    await trx.deleteFrom('oauthConsent').where('clientId', '=', clientID).execute();

    const removed = await trx
      .deleteFrom('oauthClient')
      .where('clientId', '=', clientID)
      .executeTakeFirst();

    return removed.numDeletedRows > 0n;
  });
}
