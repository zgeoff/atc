import type { Database } from 'bun:sqlite';
import type { OwnerGrant } from './seed-owner-grant';
import { seedOwnerTokens } from './seed-owner-tokens';
import type { OwnerTokens } from './seed-owner-tokens';

// This package has no code that performs an owner token refresh, so the seed writes the
// database rows directly.
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
