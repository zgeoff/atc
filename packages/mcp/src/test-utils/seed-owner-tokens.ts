import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export interface OwnerTokens {
  readonly refreshID: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface OwnerTokenRows {
  readonly ownerID: string;
  readonly clientID: string;
  readonly grantID: string;
  readonly scopes: string;
  readonly resources: string;
  readonly createdAt: string;
  readonly now: number;
}

const ACCESS_TOKEN_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_MS = 30 * 24 * 60 * 60 * 1000;

// A refresh token and the access token issued with it, as atc's own OAuth
// server wrote them before atc moved to @zgeoff/mcp-auth, each stored as its
// hash.
export function seedOwnerTokens(sqlite: Database, rows: OwnerTokenRows): OwnerTokens {
  const accessToken = randomBytes(24).toString('base64url');
  const refreshToken = randomBytes(24).toString('base64url');
  const refreshID = crypto.randomUUID();

  sqlite.run(
    'insert into "oauthRefreshToken" ("id", "token", "clientId", "userId", "authorizationCodeId", "resources", "expiresAt", "createdAt", "authTime", "scopes") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      refreshID,
      hashToken(refreshToken),
      rows.clientID,
      rows.ownerID,
      rows.grantID,
      rows.resources,
      new Date(rows.now + REFRESH_TOKEN_MS).toISOString(),
      rows.createdAt,
      rows.createdAt,
      rows.scopes,
    ],
  );

  sqlite.run(
    'insert into "oauthAccessToken" ("id", "token", "clientId", "userId", "authorizationCodeId", "resources", "refreshId", "expiresAt", "createdAt", "scopes") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
      hashToken(accessToken),
      rows.clientID,
      rows.ownerID,
      rows.grantID,
      rows.resources,
      refreshID,
      new Date(rows.now + ACCESS_TOKEN_MS).toISOString(),
      rows.createdAt,
      rows.scopes,
    ],
  );

  return { refreshID, accessToken, refreshToken };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
