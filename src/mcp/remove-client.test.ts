import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectClients } from './collect-clients';
import { collectGrants } from './collect-grants';
import { openMCPAuth } from './open-mcp-auth';
import { ReconnectingCaller } from './reconnecting-caller';
import { removeClient } from './remove-client';
import { startMCPHTTPServer } from './start-mcp-http-server';

// `atc mcp --http` on a free port with every approval line it prints
// collected, and its authorization server's database opened a second time
// the way `atc clients` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-remove-client-'));
  const dbPath = join(tmp.dir, 'mcp-auth.db');
  const approvals: string[] = [];

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    dbPath,
    printApproval: (line) => {
      approvals.push(line);
    },
    printRequest: () => {},
  });

  stack.defer(() => server.stop());

  const store = await openMCPAuth({ dbPath, origin: null });

  stack.defer(() => store.close());

  const owned = stack.move();

  return {
    url: server.url,
    origin: server.origin,
    approvals,
    store,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it removes a client and reports it removed', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const removed = await removeClient(ctx.store.db, created.clientID);

  expect(removed).toBeTrue();
  expect(collectClients(ctx.store.db)).resolves.toStrictEqual([]);
});

test('it reports an unknown client id as not removed', async () => {
  await using ctx = await setupTest();

  const removed = await removeClient(ctx.store.db, 'unknown-client');

  expect(removed).toBeFalse();
});

test("it never removes another client's tokens, consent or grant use", async () => {
  await using ctx = await setupTest();

  const removed = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const kept = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Cursor', redirectURIs: ['https://cursor.com/oauth/callback'] },
  });

  for (const client of [
    { clientID: removed.clientID, redirectURI: 'https://claude.ai/api/mcp/auth_callback' },
    { clientID: kept.clientID, redirectURI: 'https://cursor.com/oauth/callback' },
  ]) {
    const authorized = await runMCPAuthorization(ctx, {
      ...client,
      scope: 'read',
      ticked: ['read'],
    });

    await fetch(`${ctx.url}/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorized.code,
        redirect_uri: client.redirectURI,
        client_id: client.clientID,
        code_verifier: authorized.verifier,
      }),
    });
  }

  const grants = await collectGrants(ctx.store.db);

  await ctx.store.db
    .insertInto('atc_grant_use')
    .values(
      grants.map((grant) => ({
        grant_id: grant.grantID,
        last_used_at: '2026-10-08T00:00:00.000Z',
      })),
    )
    .execute();

  const keptGrant = grants.find((grant) => grant.clientID === kept.clientID);

  invariant(keptGrant !== undefined, 'the exchange left the kept client no grant');

  await removeClient(ctx.store.db, removed.clientID);

  const left = {
    accessTokens: await ctx.store.db.selectFrom('oauthAccessToken').select('clientId').execute(),
    refreshTokens: await ctx.store.db.selectFrom('oauthRefreshToken').select('clientId').execute(),
    consents: await ctx.store.db.selectFrom('oauthConsent').select('clientId').execute(),
    grantUses: await ctx.store.db.selectFrom('atc_grant_use').select('grant_id').execute(),
  };

  expect(left).toStrictEqual({
    accessTokens: [{ clientId: kept.clientID }],
    refreshTokens: [{ clientId: kept.clientID }],
    consents: [{ clientId: kept.clientID }],
    grantUses: [{ grant_id: keptGrant.grantID }],
  });
});
