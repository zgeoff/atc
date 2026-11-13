import type { Database } from 'bun:sqlite';

// The tables atc's own OAuth server made before it moved to @zgeoff/mcp-auth,
// as better-auth 1.7.15 wrote them, and atc's grant use table beside them.
const OWNER_SCHEMA = [
  `CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null)`,
  `CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
  `CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
  `CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
  `CREATE TABLE "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text)`,
  `CREATE TABLE "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null)`,
  `CREATE TABLE "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null)`,
  `CREATE TABLE "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null)`,
  `CREATE TABLE "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text)`,
  `CREATE TABLE "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date)`,
  `CREATE TABLE "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null)`,
  `CREATE INDEX "session_userId_idx" on "session" ("userId")`,
  `CREATE INDEX "account_userId_idx" on "account" ("userId")`,
  `CREATE INDEX "verification_identifier_idx" on "verification" ("identifier")`,
  `CREATE INDEX "oauthClient_userId_idx" on "oauthClient" ("userId")`,
  `CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId")`,
  `CREATE INDEX "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId")`,
  `CREATE INDEX "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId")`,
  `CREATE INDEX "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId")`,
  `CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId")`,
  `CREATE INDEX "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId")`,
  `CREATE INDEX "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId")`,
  `CREATE INDEX "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId")`,
  `CREATE INDEX "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId")`,
  `CREATE INDEX "oauthConsent_clientId_idx" on "oauthConsent" ("clientId")`,
  `CREATE INDEX "oauthConsent_userId_idx" on "oauthConsent" ("userId")`,
  `CREATE INDEX "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId")`,
  `CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId")`,
  `CREATE INDEX "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId")`,
  `CREATE TABLE atc_grant_use (grant_id text primary key not null, last_used_at text not null)`,
  `CREATE TABLE atc_passkey (id text primary key not null, public_key text not null, counter integer not null, transports text not null, created_at text not null, last_used_at text)`,
  `CREATE TABLE atc_enrollment_token (token_hash text primary key not null, created_at text not null, expires_at text not null)`,
];

export interface OwnerSchema {
  readonly ownerID: string;
}

// A database from before atc moved to @zgeoff/mcp-auth: no code here makes
// it now. Every grant's tokens point at the one owner row this writes.
export function seedOwnerSchema(sqlite: Database): OwnerSchema {
  for (const statement of OWNER_SCHEMA) {
    sqlite.run(statement);
  }

  const ownerID = crypto.randomUUID();

  const now = new Date().toISOString();

  sqlite.run(
    'insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?)',
    [ownerID, 'owner', 'owner@atc.invalid', 1, now, now],
  );

  return { ownerID };
}
