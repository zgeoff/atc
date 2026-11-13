import type { Database } from 'bun:sqlite';
import type { OwnerGrant } from './seed-owner-grant';
import { seedOwnerTokens } from './seed-owner-tokens';
import type { OwnerTokens } from './seed-owner-tokens';

// A refresh of a grant as atc's own OAuth server ran it before atc moved to
// @zgeoff/mcp-auth, which no code here makes now: it revoked the refresh
// token, and stored a new pair that keeps the grant's authorization code.
export function seedOwnerRefresh(sqlite: Database, grant: OwnerGrant): OwnerTokens {
  const now = Date.now();

  const createdAt = new Date(Math.floor(now / 1000) * 1000).toISOString();

  sqlite.run('update "oauthRefreshToken" set "revoked" = ? where "id" = ?', [
    createdAt,
    grant.refreshID,
  ]);

  return seedOwnerTokens(sqlite, {
    ownerID: grant.ownerID,
    clientID: grant.clientID,
    grantID: grant.grantID,
    scopes: grant.scopes,
    resources: grant.resources,
    createdAt,
    now,
  });
}
