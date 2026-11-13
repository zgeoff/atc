import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { collectGrantRows } from './collect-grant-rows';
import type { OwnerToken } from './collect-grant-rows';

// Splits the one owner user row of atc's own OAuth server into one row per
// grant, as @zgeoff/mcp-auth needs, before every open. It returns whether it
// changed the database, and leaves a new or already split one alone.
export function runGrantMigration(sqlite: Database, now: number): boolean {
  if (!probeOwnerUserTable(sqlite)) {
    return false;
  }

  // The user table is dropped and made again. With foreign keys on, the drop
  // would delete every token through its cascade, so they go off around the
  // transaction, and foreign_key_check proves the result before it commits.
  sqlite.run('PRAGMA foreign_keys = OFF');

  if (readForeignKeys(sqlite) !== 0) {
    throw new Error('the grant migration could not turn foreign keys off');
  }

  try {
    return sqlite
      .transaction(() => migrateOwnerRows(sqlite, new Date(now).toISOString()))
      .immediate();
  } finally {
    sqlite.run('PRAGMA foreign_keys = ON');
  }
}

// atc's own server made a user table without the package's grant columns.
function probeOwnerUserTable(sqlite: Database): boolean {
  const columns = readColumns(sqlite, 'user');

  return columns.length > 0 && !columns.includes('clientId');
}

const ColumnRowSchema = z.object({ name: z.string() });

function readColumns(sqlite: Database, table: string): string[] {
  return sqlite
    .query(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => ColumnRowSchema.parse(row).name);
}

const PragmaRowSchema = z.object({ foreign_keys: z.number() });

function readForeignKeys(sqlite: Database): number {
  return PragmaRowSchema.parse(sqlite.query('PRAGMA foreign_keys').get()).foreign_keys;
}

// The user table that @zgeoff/mcp-auth creates: one row per grant.
const GRANT_USER_TABLE = `CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "clientId" text not null, "scopes" text, "approvedBy" text not null, "limits" text, "lastUsedAt" date)`;
const CASCADING_TABLES = ['oauthAccessToken', 'oauthRefreshToken', 'session'] as const;
const ClientRowSchema = z.object({ clientId: z.string(), name: z.string().nullable() });
const UseRowSchema = z.object({ grant_id: z.string(), last_used_at: z.string() });

function migrateOwnerRows(sqlite: Database, now: string): boolean {
  // Another process may have migrated between the first check and the lock.
  if (!probeOwnerUserTable(sqlite)) {
    return false;
  }

  const tokens: OwnerToken[] = [
    ...readTokens(sqlite, 'oauthRefreshToken'),
    ...readTokens(sqlite, 'oauthAccessToken'),
  ];

  const clients = sqlite
    .query('select "clientId", "name" from "oauthClient"')
    .all()
    .map((row) => ClientRowSchema.parse(row));

  const uses = probeTable(sqlite, 'atc_grant_use')
    ? sqlite
        .query('select grant_id, last_used_at from atc_grant_use')
        .all()
        .map((row) => UseRowSchema.parse(row))
    : [];

  const grants = collectGrantRows({
    tokens,
    clientNames: new Map(clients.map((client) => [client.clientId, client.name ?? ''])),
    lastUsedAt: new Map(uses.map((use) => [use.grant_id, use.last_used_at])),
    now,
  });

  sqlite.run('drop table "user"');
  sqlite.run(GRANT_USER_TABLE);

  const insert = sqlite.prepare(
    'insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "clientId", "scopes", "approvedBy", "limits", "lastUsedAt") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  for (const grant of grants) {
    insert.run(
      grant.id,
      grant.name,
      grant.email,
      grant.emailVerified,
      grant.createdAt,
      grant.updatedAt,
      grant.clientId,
      grant.scopes,
      grant.approvedBy,
      grant.limits,
      grant.lastUsedAt,
    );
  }

  // A token of a collected grant, rotated ones included, points at its row,
  // and every other token goes with the owner row.
  for (const table of ['oauthRefreshToken', 'oauthAccessToken'] as const) {
    sqlite.run(
      `delete from "${table}" where "authorizationCodeId" is null or "authorizationCodeId" not in (select "id" from "user")`,
    );

    sqlite.run(`update "${table}" set "userId" = "authorizationCodeId"`);
  }

  // The owner's sessions, consents and accounts pointed at the owner row.
  sqlite.run('delete from "session"');
  sqlite.run('delete from "oauthConsent"');
  sqlite.run('delete from "account"');
  sqlite.run('update "oauthClient" set "userId" = null where "userId" is not null');
  sqlite.run('drop table if exists atc_grant_use');

  // atc's tables already reference user(id) on delete cascade, so they need
  // no rebuild; the package refuses to open without it.
  for (const table of CASCADING_TABLES) {
    if (!hasCascadingUserKey(sqlite, table)) {
      throw new Error(`${table}.userId does not reference user(id) on delete cascade`);
    }
  }

  const broken = sqlite.query('PRAGMA foreign_key_check').all();

  if (broken.length > 0) {
    throw new Error(`the grant migration left ${broken.length} rows that break a foreign key`);
  }

  return true;
}

const TokenRowSchema = z.object({
  authorizationCodeId: z.string().nullable(),
  clientId: z.string(),
  scopes: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revoked: z.string().nullable(),
});

// Newest first, so a grant takes its scopes from its newest live token.
function readTokens(
  sqlite: Database,
  table: 'oauthRefreshToken' | 'oauthAccessToken',
): OwnerToken[] {
  return sqlite
    .query(
      `select "authorizationCodeId", "clientId", "scopes", "createdAt", "expiresAt", "revoked" from "${table}" order by "createdAt" desc`,
    )
    .all()
    .map((row) => TokenRowSchema.parse(row));
}

function probeTable(sqlite: Database, table: string): boolean {
  return readColumns(sqlite, table).length > 0;
}

const KeyRowSchema = z.object({ table: z.string(), from: z.string(), on_delete: z.string() });

function hasCascadingUserKey(sqlite: Database, table: string): boolean {
  return sqlite
    .query(`PRAGMA foreign_key_list("${table}")`)
    .all()
    .map((row) => KeyRowSchema.parse(row))
    .some((key) => key.table === 'user' && key.from === 'userId' && key.on_delete === 'CASCADE');
}
