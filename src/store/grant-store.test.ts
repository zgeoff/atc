import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state-store';

async function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-grants-'));

  const store = await StateStore.open(join(dir, 'state.db'));

  return {
    grants: store.grants,
    async [Symbol.asyncDispose]() {
      await store.stop();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it verifies a fresh access token and returns its grant scopes', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'message'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const a1Access = await ctx.grants.verifyAccessToken('a1', 'https://atc.example/mcp', 2000);

  expect(a1Access).toStrictEqual({
    grantID: 'g1',
    clientName: 'dots',
    scopes: ['read', 'message'],
  });
});

test('it rejects an access token presented for a different resource', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const a1Access = await ctx.grants.verifyAccessToken('a1', 'https://other.example/mcp', 2000);

  expect(a1Access).toBeNull();
});

test('it rejects an access token after it expires', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 500,
    refreshMs: 2_592_000_000,
  });

  const a1Access = await ctx.grants.verifyAccessToken('a1', 'https://atc.example/mcp', 1500);

  expect(a1Access).toBeNull();
});

test('it rotates a refresh token into an access token that verifies', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const outcome = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(outcome).toStrictEqual({
    kind: 'rotated',
    grantID: 'g1',
    clientName: 'dots',
    scopes: ['read'],
  });

  const a2Access = await ctx.grants.verifyAccessToken('a2', 'https://atc.example/mcp', 3000);

  expect(a2Access).toStrictEqual({
    grantID: 'g1',
    clientName: 'dots',
    scopes: ['read'],
  });
});

test('it refuses a refresh token presented by a different client', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const outcome = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c2',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(outcome).toStrictEqual({ kind: 'invalid' });
});

test('it reissues a pair when a spent refresh token is retried before its successor is used', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  const retried = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 5000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(retried).toStrictEqual({
    kind: 'rotated',
    grantID: 'g1',
    clientName: 'dots',
    scopes: ['read'],
  });

  const a3Access = await ctx.grants.verifyAccessToken('a3', 'https://atc.example/mcp', 6000);

  expect(a3Access).toStrictEqual({ grantID: 'g1', clientName: 'dots', scopes: ['read'] });
});

test('it revokes the grant when the access token a retry superseded is presented', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 5000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  const a2Access = await ctx.grants.verifyAccessToken('a2', 'https://atc.example/mcp', 6000);

  expect(a2Access).toBeNull();

  const a3Access = await ctx.grants.verifyAccessToken('a3', 'https://atc.example/mcp', 7000);

  expect(a3Access).toBeNull();

  const grants = await ctx.grants.collectGrants();

  expect(grants).toStrictEqual([]);
});

test('it revokes the grant when the refresh token a retry superseded is presented', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 5000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  const superseded = await ctx.grants.refreshGrant({
    refreshHash: 'r2',
    accessHash: 'a4',
    nextRefreshHash: 'r4',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 6000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(superseded).toStrictEqual({ kind: 'revoked' });

  const a3Access = await ctx.grants.verifyAccessToken('a3', 'https://atc.example/mcp', 7000);

  expect(a3Access).toBeNull();

  const grants = await ctx.grants.collectGrants();

  expect(grants).toStrictEqual([]);
});

test('it refuses a refresh token presented for a different resource', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const outcome = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://other.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(outcome).toStrictEqual({ kind: 'invalid' });
});

test('it refuses a refresh token after it expires', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 500,
    refreshMs: 1000,
  });

  const outcome = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(outcome).toStrictEqual({ kind: 'invalid' });
});

test('it revokes the grant when a spent refresh token returns after its successor was used', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  await ctx.grants.verifyAccessToken('a2', 'https://atc.example/mcp', 3000);

  const reused = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 4000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(reused).toStrictEqual({ kind: 'revoked' });

  const a2Access = await ctx.grants.verifyAccessToken('a2', 'https://atc.example/mcp', 5000);

  expect(a2Access).toBeNull();

  const grants = await ctx.grants.collectGrants();

  expect(grants).toStrictEqual([]);
});

test('it revokes the grant when a spent refresh token returns after the retry window', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a2',
    nextRefreshHash: 'r2',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 2000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  const reused = await ctx.grants.refreshGrant({
    refreshHash: 'r1',
    accessHash: 'a3',
    nextRefreshHash: 'r3',
    clientID: 'c1',
    resource: 'https://atc.example/mcp',
    now: 200_000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
    retryWindowMs: 120_000,
  });

  expect(reused).toStrictEqual({ kind: 'revoked' });
});

test('it stops verifying an access token once its grant is revoked', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const revokedG1 = await ctx.grants.revokeGrant('g1', 2000);

  expect(revokedG1).toBeTrue();

  const a1Access = await ctx.grants.verifyAccessToken('a1', 'https://atc.example/mcp', 3000);

  expect(a1Access).toBeNull();
});

test('it reports revoking an unknown grant as no change', async () => {
  await using ctx = await setupTest();

  const revokedMissing = await ctx.grants.revokeGrant('missing', 1000);

  expect(revokedMissing).toBeFalse();
});

test('it lists live grants with their last use and no token material', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read', 'kill'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.verifyAccessToken('a1', 'https://atc.example/mcp', 2500);

  const grants = await ctx.grants.collectGrants();

  expect(grants).toStrictEqual([
    {
      id: 'g1',
      clientID: 'c1',
      clientName: 'dots',
      scopes: ['read', 'kill'],
      resource: 'https://atc.example/mcp',
      createdAt: 1000,
      lastUsedAt: 2500,
    },
  ]);
});

test('it removes a grant whose refresh token expired', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 100,
    refreshMs: 1000,
  });

  await ctx.grants.removeExpiredGrants(5000, 600_000);

  const grants = await ctx.grants.collectGrants();

  expect(grants).toStrictEqual([]);
});

test('it removes a registered client that never gained a grant once its grace ends', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createClient(
    { clientID: 'c1', name: 'dots', redirectURIs: ['https://chatgpt.com/cb'] },
    1000,
  );

  await ctx.grants.removeExpiredGrants(700_000, 600_000);

  const client = await ctx.grants.findClient('c1');

  expect(client).toBeNull();
});

test('it keeps a registered client while a grant uses it', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createClient(
    { clientID: 'c1', name: 'dots', redirectURIs: ['https://chatgpt.com/cb'] },
    1000,
  );

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  await ctx.grants.removeExpiredGrants(700_000, 600_000);

  const client = await ctx.grants.findClient('c1');

  expect(client).toStrictEqual({
    clientID: 'c1',
    name: 'dots',
    redirectURIs: ['https://chatgpt.com/cb'],
  });
});

test('it counts only registered clients that hold no grant', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createClient(
    { clientID: 'c1', name: 'dots', redirectURIs: ['https://chatgpt.com/cb'] },
    1000,
  );

  await ctx.grants.createClient(
    { clientID: 'c2', name: 'lines', redirectURIs: ['https://chatgpt.com/cb'] },
    1000,
  );

  await ctx.grants.createGrant({
    id: 'g1',
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
    accessHash: 'a1',
    refreshHash: 'r1',
    now: 1000,
    accessMs: 3_600_000,
    refreshMs: 2_592_000_000,
  });

  const waiting = await ctx.grants.countClientsWithoutGrant();

  expect(waiting).toBe(1);
});

test('it finds a stored client name with its control characters dropped', async () => {
  await using ctx = await setupTest();

  await ctx.grants.createClient(
    {
      clientID: 'c1',
      name: 'dots\u001B]52;c;AAAA\u0007\nforged',
      redirectURIs: ['https://chatgpt.com/cb'],
    },
    1000,
  );

  const client = await ctx.grants.findClient('c1');

  expect(client).toStrictEqual({
    clientID: 'c1',
    name: 'dots]52;c;AAAA forged',
    redirectURIs: ['https://chatgpt.com/cb'],
  });
});
