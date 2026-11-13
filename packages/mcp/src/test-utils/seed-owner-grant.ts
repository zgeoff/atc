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

  // The authorization code the tokens carry, which becomes the grant's ID;
  // drawn at random when left out.
  readonly grantID?: string;
}

export interface OwnerGrant extends OwnerTokens {
  readonly grantID: GrantID;
  readonly ownerID: string;
  readonly clientID: OAuthClientID;
  readonly scopes: string;
  readonly resources: string;
}

// One grant as atc's own OAuth server wrote it at the code exchange, before
// atc moved to @zgeoff/mcp-auth: a consent and a token pair on the owner row,
// the tokens stamped with the authorization code they came from.
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
