import { parseJSONStrings } from '@atc/core';
import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';

// A subscription delivers what the client could read, so it ends with the
// client's last live grant that holds read, rather than at its refreshBefore.
export async function removeUnauthorizedSubscriptions(
  db: Kysely<MCPAuthSchema>,
  clientID: string,
): Promise<void> {
  const grants = await db
    .selectFrom('oauthRefreshToken')
    .select('scopes')
    .where('clientId', '=', clientID)
    .where('revoked', 'is', null)
    .where('expiresAt', '>', new Date().toISOString())
    .execute();

  if (grants.some((grant) => (parseJSONStrings(grant.scopes) ?? []).includes('read'))) {
    return;
  }

  await db.deleteFrom('atc_event_subscription').where('client_id', '=', clientID).execute();
  await db.deleteFrom('atc_event_callback').where('client_id', '=', clientID).execute();
}
