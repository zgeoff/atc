import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from './mcp-auth-schema';

/**
 * Revokes a grant: its access and refresh tokens go, along with the
 * consent its client holds, so the client must go through approval again.
 * Returns false for an unknown grant id.
 */
export function revokeGrant(db: Kysely<MCPAuthSchema>, grantID: string): Promise<boolean> {
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

    return true;
  });
}
