import type { Kysely } from 'kysely';
import { removeUnauthorizedSubscriptions } from '../events/remove-unauthorized-subscriptions';
import type { MCPAuthSchema } from './mcp-auth-schema';

export function revokeGrant(
  db: Kysely<MCPAuthSchema>,
  grantID: string,
  now: number,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const grant = await trx
      .selectFrom('oauthRefreshToken')
      .select('clientId')
      .where('authorizationCodeId', '=', grantID)
      .executeTakeFirst();

    if (grant === undefined) {
      return false;
    }

    await trx.deleteFrom('oauthAccessToken').where('authorizationCodeId', '=', grantID).execute();
    await trx.deleteFrom('oauthRefreshToken').where('authorizationCodeId', '=', grantID).execute();
    await trx.deleteFrom('oauthConsent').where('clientId', '=', grant.clientId).execute();
    await trx.deleteFrom('atc_grant_use').where('grant_id', '=', grantID).execute();

    await removeUnauthorizedSubscriptions(trx, grant.clientId, now);

    return true;
  });
}
