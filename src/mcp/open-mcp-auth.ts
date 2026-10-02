import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { mcp } from '@better-auth/mcp';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { OAuthOptions, Scope } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { GRANT_SCOPES } from '../shared/grant-scope';
import { BunSqliteDriver } from '../store/bun-sqlite-driver';
import { buildOwnerPlugin } from './build-owner-plugin';
import { deriveTokenHash } from './derive-token-hash';
import type { MCPAuthSchema } from './types';

interface MCPAuthOptions {
  readonly dbPath: string;

  // The public origin: the issuer, with `<origin>/mcp` the one resource tokens
  // are bound to. Null opens the store to manage clients and grants only, with
  // no resource served.
  readonly origin: string | null;

  // How long a rotated refresh token still answers with its successor; 0
  // treats any reuse as replay.
  readonly refreshReuseSeconds?: number;
}

// How long an approval page, its signed query, and an authorization code each
// stay valid.
const APPROVAL_SECONDS = 600;

// The owner's session lives only to carry one approval from the code page
// through consent to the code exchange, which every token detaches from.
const OWNER_SESSION_SECONDS = 3 * APPROVAL_SECONDS;

/**
 * Opens the authorization server's SQLite database and the better-auth
 * instance over it, creating or updating its tables, with the file readable
 * and writable by its owner only. better-auth runs the OAuth 2.1 flows: fixed
 * public clients, PKCE, opaque access tokens, rotating refresh tokens, and
 * revocation. Telemetry stays off whatever the environment says.
 */
export async function openMCPAuth(options: MCPAuthOptions) {
  // better-auth reads these when it builds its context; an empty endpoint
  // turns its telemetry into a no-op.
  process.env['BETTER_AUTH_TELEMETRY'] = '0';
  process.env['BETTER_AUTH_TELEMETRY_ENDPOINT'] = '';

  // The file holds token hashes and owner sessions, so only its owner may
  // read it. SQLite gives the WAL and shared-memory files the main file's
  // mode, so the mode is set before SQLite opens it.
  closeSync(openSync(options.dbPath, 'a', 0o600));
  chmodSync(options.dbPath, 0o600);

  const sqlite = new Database(options.dbPath, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA busy_timeout = 5000;');

  // The schema declares cascades from a client to its tokens and consent,
  // which SQLite enforces only with foreign keys on.
  sqlite.run('PRAGMA foreign_keys = ON;');

  const db = new Kysely<MCPAuthSchema>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  const providerOptions: OAuthOptions<Scope[]> = {
    loginPage: '/login',
    consentPage: '/consent',
    scopes: [...GRANT_SCOPES, 'offline_access'],
    disableJwtPlugin: true,
    allowDynamicClientRegistration: false,
    grantTypes: ['authorization_code', 'refresh_token'],

    // atc serves one resource, so every client may request it.
    enforcePerClientResources: false,
    accessTokenExpiresIn: 3600,
    codeExpiresIn: APPROVAL_SECONDS,
    refreshTokenReuseInterval: options.refreshReuseSeconds ?? 0,
    storeTokens: { hash: (token: string) => Promise.resolve(deriveTokenHash(token)) },
  };

  const provider =
    options.origin === null
      ? oauthProvider(providerOptions)
      : mcp({ ...providerOptions, resource: `${options.origin}/mcp` });

  const baseURL = options.origin ?? 'http://127.0.0.1';

  const auth = betterAuth({
    baseURL,
    basePath: '/',
    secret: randomBytes(32).toString('base64url'),
    database: { db, type: 'sqlite' },
    telemetry: { enabled: false },
    logger: { level: 'error' },
    rateLimit: { enabled: false },

    // Every open runs the migrations itself, so the startup schema check
    // would only report the tables a fresh database has yet to get.
    advanced: { database: { validateSchema: false } },
    trustedOrigins: [baseURL],
    session: { expiresIn: OWNER_SESSION_SECONDS, disableSessionRefresh: true },

    // The provider's own endpoint types do not satisfy the plugin type under
    // exactOptionalPropertyTypes, so atc reaches them over HTTP-shaped requests.
    // oxlint-disable-next-line no-unsafe-type-assertion -- the plugin is a BetterAuthPlugin at runtime; only its endpoint option types disagree with the stricter compiler settings
    plugins: [provider as BetterAuthPlugin, buildOwnerPlugin()],
  });

  const migrations = await getMigrations(auth.options);

  await migrations.runMigrations();

  await sql`create table if not exists atc_grant_use (grant_id text primary key not null, last_used_at text not null)`.execute(
    db,
  );

  // A resource served under an earlier public URL stays a valid token target
  // until its row goes.
  if (options.origin !== null) {
    await db
      .deleteFrom('oauthResource')
      .where('identifier', '!=', `${options.origin}/mcp`)
      .execute();
  }

  return {
    auth,
    db,
    async close(): Promise<void> {
      await db.destroy();

      sqlite.close();
    },
  };
}
