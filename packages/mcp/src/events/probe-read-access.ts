import { parseJSONStrings } from '@atc/core';
import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';

// A client reads as long as one of its refresh tokens is live and holds read.
// The authorization server rotates the refresh token on each refresh, so the
// live token carries the grant, whichever route revoked or expired the rest.
export async function probeReadAccess(
  db: Kysely<MCPAuthSchema>,
  clientID: string,
  now: number,
): Promise<boolean> {
  const grants = await db
    .selectFrom('oauthRefreshToken')
    .select('scopes')
    .where('clientId', '=', clientID)
    .where('revoked', 'is', null)
    .where('expiresAt', '>', new Date(now).toISOString())
    .execute();

  return grants.some((grant) => (parseJSONStrings(grant.scopes) ?? []).includes('read'));
}
