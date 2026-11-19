import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { GrantID, OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { seedOwnerTokens } from './seed-owner-tokens';
import type { OwnerTokens } from './seed-owner-tokens';

export interface OwnerGrantInput {
  readonly ownerID: string;
  readonly clientID: OAuthClientID;

  // `<origin>/mcp`, which every token names.
  readonly resource: string;
  readonly scopes: readonly string[];

  readonly grantID?: string;
}

export interface OwnerGrant extends OwnerTokens {
  readonly grantID: GrantID;
  readonly ownerID: string;
  readonly clientID: OAuthClientID;
  readonly scopes: string;
  readonly resources: string;
}

// Existing databases hold grant rows in this shape, not the one the auth library writes,
// so seed this shape to test against the data that is actually stored.
export function seedOwnerGrant(sqlite: Database, input: OwnerGrantInput): OwnerGrant {
  const grantID = toTagged<GrantID>(input.grantID ?? randomBytes(32).toString('base64url'));
  const scopes = JSON.stringify([...input.scopes, 'offline_access']);
  const resources = JSON.stringify([input.resource]);
  const now = Date.now();

  const createdAt = new Date(Math.floor(now / 1000) * 1000).toISOString();

  sqlite.run(
    'insert into "oauthConsent" ("id", "clientId", "userId", "resources", "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
      input.clientID,
      input.ownerID,
      resources,
      '[]',
      scopes,
      createdAt,
      createdAt,
    ],
  );

  const issued = seedOwnerTokens(sqlite, {
    ownerID: input.ownerID,
    clientID: input.clientID,
    grantID,
    scopes,
    resources,
    createdAt,
    now,
  });

  return {
    grantID,
    ownerID: input.ownerID,
    clientID: input.clientID,
    scopes,
    resources,
    ...issued,
  };
}
