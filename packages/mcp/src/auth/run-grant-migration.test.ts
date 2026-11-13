import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import type { PasskeyID } from '@zgeoff/mcp-auth';
import { buildTestRequester, createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { toTagged } from '@zgeoff/std';
import { readTableShapes } from '../test-utils/read-table-shapes';
import { seedOwnerClient } from '../test-utils/seed-owner-client';
import { seedOwnerGrant } from '../test-utils/seed-owner-grant';
import { seedOwnerGrantUse } from '../test-utils/seed-owner-grant-use';
import { seedOwnerRefresh } from '../test-utils/seed-owner-refresh';
import { seedOwnerSchema } from '../test-utils/seed-owner-schema';
import { openATCAuth } from './open-atc-auth';
import { openATCAuthAdmin } from './open-atc-auth-admin';
import { runGrantMigration } from './run-grant-migration';

// A database of atc's own OAuth server, before the package, on one
// connection with foreign keys on, as the app opens it.
function setupTest() {
  const sqlite = createTestDatabase();

  sqlite.run('PRAGMA foreign_keys = ON');

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const clock = { now: () => Date.now() };
  const origin = 'https://atc.example';

  return {
    sqlite,
    origin,
    ownerID: owner.ownerID,
    migrate: () => runGrantMigration(sqlite, clock.now()),
    openAuth: async () => {
      const auth = await openATCAuth({
        database: sqlite,
        origin,
        clock,
        security: { record: () => {} },
        serviceTokens: null,
        onGrantRevoked: () => {},
      });

      registerTestCleanup(() => auth.close());

      return auth;
    },
    openAdmin: async () => {
      const admin = await openATCAuthAdmin(sqlite, clock);

      registerTestCleanup(() => admin.close());

      return admin;
    },
  };
}

test('it keeps the access token of each grant valid, and of a refreshed one the newest', async () => {
  const ctx = setupTest();
  const first = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });
  const second = seedOwnerClient(ctx.sqlite, { name: 'Beta' });

  const kept = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: first.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  const refreshed = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: second.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read', 'message'],
  });

  const rotated = seedOwnerRefresh(ctx.sqlite, refreshed);

  ctx.migrate();

  const auth = await ctx.openAuth();

  expect(
    Promise.all([auth.verify(kept.accessToken), auth.verify(rotated.accessToken)]),
  ).resolves.toStrictEqual([
    {
      kind: 'oauth',
      grantID: kept.grantID,
      clientID: first.clientID,
      clientName: 'Alpha',
      scopes: ['read'],
      limits: null,
    },
    {
      kind: 'oauth',
      grantID: refreshed.grantID,
      clientID: second.clientID,
      clientName: 'Beta',
      scopes: ['read', 'message'],
      limits: null,
    },
  ]);
});

test('it ends only the revoked grant once the migration splits the owner row', async () => {
  const ctx = setupTest();
  const first = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });
  const second = seedOwnerClient(ctx.sqlite, { name: 'Beta' });

  const kept = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: first.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  const refreshed = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: second.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  const rotated = seedOwnerRefresh(ctx.sqlite, refreshed);

  ctx.migrate();

  const auth = await ctx.openAuth();

  await auth.grants.revoke(refreshed.grantID);

  expect(
    Promise.all([auth.verify(rotated.accessToken), auth.verify(kept.accessToken)]),
  ).resolves.toStrictEqual([null, expect.objectContaining({ grantID: kept.grantID })]);
});

test('it refreshes a refreshed grant once more after the migration', async () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  const granted = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  const rotated = seedOwnerRefresh(ctx.sqlite, granted);

  ctx.migrate();

  const auth = await ctx.openAuth();

  const refreshed = await auth.routes.token(
    new Request(`${ctx.origin}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rotated.refreshToken,
        client_id: client.clientID,
      }),
    }),
    buildTestRequester(),
  );

  expect(refreshed.status).toBe(200);
});

test('it lists one grant per authorization code a live token carries, with its last use', async () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  const used = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read', 'kill'],
  });

  const unused = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  seedOwnerGrantUse(ctx.sqlite, { grantID: used.grantID, lastUsedAt: '2026-11-01T10:00:00.000Z' });

  ctx.migrate();

  const admin = await ctx.openAdmin();

  expect(admin.grants.list()).resolves.toIncludeSameMembers([
    {
      grantID: used.grantID,
      clientID: client.clientID,
      clientName: 'Alpha',
      scopes: ['read', 'kill'],
      approvedBy: 'passkey',
      createdAt: expect.toBeString(),
      lastUsedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      grantID: unused.grantID,
      clientID: client.clientID,
      clientName: 'Alpha',
      scopes: ['read'],
      approvedBy: 'passkey',
      createdAt: expect.toBeString(),
      lastUsedAt: null,
    },
  ]);
});

test('it leaves out a grant whose tokens are all revoked', async () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  const granted = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  ctx.sqlite.run('update "oauthRefreshToken" set "revoked" = ?', [new Date().toISOString()]);
  ctx.sqlite.run('update "oauthAccessToken" set "revoked" = ?', [new Date().toISOString()]);
  ctx.migrate();

  const admin = await ctx.openAdmin();

  expect(admin.grants.list()).resolves.toStrictEqual([]);

  expect(ctx.sqlite.query('select id from "user"').all()).not.toContainEqual({
    id: granted.grantID,
  });
});

test('it keeps the clients and passkeys in the tables they were in', async () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  ctx.sqlite.run(
    'insert into atc_passkey (id, public_key, counter, transports, created_at) values (?, ?, ?, ?, ?)',
    ['credential-1', 'key-1', 0, '[]', '2026-10-01T10:00:00.000Z'],
  );

  ctx.migrate();

  const admin = await ctx.openAdmin();

  expect(Promise.all([admin.clients.list(), admin.passkeys.list()])).resolves.toStrictEqual([
    [
      {
        clientID: client.clientID,
        name: 'Alpha',
        redirectURIs: ['https://claude.ai/api/mcp/auth_callback'],
        createdAt: expect.toBeString(),
      },
    ],
    [
      {
        id: toTagged<PasskeyID>('credential-1'),
        createdAt: '2026-10-01T10:00:00.000Z',
        lastUsedAt: null,
      },
    ],
  ]);
});

test('it leaves the tables the package needs in the shape the package makes them', async () => {
  const ctx = setupTest();
  const fresh = createTestDatabase();

  registerTestCleanup(() => {
    fresh.close();
  });

  ctx.migrate();

  await ctx.openAdmin();

  const made = await openATCAuthAdmin(fresh, { now: () => Date.now() });

  registerTestCleanup(() => made.close());

  expect(readTableShapes(ctx.sqlite)).toStrictEqual(readTableShapes(fresh));
});

test('it ends with foreign_key_check returning no rows', () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  ctx.migrate();

  expect(ctx.sqlite.query('PRAGMA foreign_key_check').all()).toStrictEqual([]);
});

test('it turns foreign keys back on after it runs', () => {
  const ctx = setupTest();

  ctx.migrate();

  expect(ctx.sqlite.query('PRAGMA foreign_keys').get()).toStrictEqual({ foreign_keys: 1 });
});

test('it changes nothing on a second run', () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  ctx.migrate();

  const before = ctx.sqlite.query('select * from "user"').all();

  expect({
    ran: ctx.migrate(),
    rows: ctx.sqlite.query('select * from "user"').all(),
  }).toStrictEqual({ ran: false, rows: before });
});

test('it leaves a new database alone', () => {
  const sqlite = new Database(':memory:');

  registerTestCleanup(() => {
    sqlite.close();
  });

  expect(runGrantMigration(sqlite, Date.now())).toBeFalse();
});

test('it rolls the whole move back when a step after the drop fails', () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Alpha' });

  const grant = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: client.clientID,
    resource: `${ctx.origin}/mcp`,
    scopes: ['read'],
  });

  seedOwnerGrantUse(ctx.sqlite, { grantID: grant.grantID, lastUsedAt: '2026-10-14T12:00:00.000Z' });

  // The consents go after the user table is made again.
  ctx.sqlite.run(
    'CREATE TRIGGER refuse_consent_delete BEFORE DELETE ON "oauthConsent" BEGIN SELECT RAISE(ABORT, \'consent delete refused\'); END',
  );

  const before = readTableShapes(ctx.sqlite);

  expect(() => ctx.migrate()).toThrow('consent delete refused');

  expect({
    shapes: readTableShapes(ctx.sqlite),
    users: ctx.sqlite.query('select "id" from "user"').all(),
    refreshTokens: ctx.sqlite.query('select "userId" from "oauthRefreshToken"').all(),
    accessTokens: ctx.sqlite.query('select "userId" from "oauthAccessToken"').all(),
    uses: ctx.sqlite.query('select grant_id from atc_grant_use').all(),
    foreignKeys: ctx.sqlite.query('PRAGMA foreign_keys').get(),
  }).toStrictEqual({
    shapes: before,
    users: [{ id: ctx.ownerID }],
    refreshTokens: [{ userId: ctx.ownerID }],
    accessTokens: [{ userId: ctx.ownerID }],
    uses: [{ grant_id: grant.grantID }],
    foreignKeys: { foreign_keys: 1 },
  });
});
