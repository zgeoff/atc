import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectGrants } from './collect-grants';
import { openMCPAuth } from './open-mcp-auth';
import { ReconnectingCaller } from './reconnecting-caller';
import { revokeGrant } from './revoke-grant';
import { startMCPHTTPServer } from './start-mcp-http-server';

// `atc mcp --http` on a free port with every approval line it prints
// collected, and its authorization server's database opened a second time
// the way `atc grants` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const tmp = setupTempDir('atc-revoke-grant-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');
  const approvals: string[] = [];

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

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

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, origin: null });

  registerTestCleanup(() => store.close());

  return { url: server.url, origin: server.origin, approvals, store };
}

test("it forgets the consent its client held along with the grant's tokens", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const [grant] = await collectGrants(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  const revoked = await revokeGrant(ctx.store.db, grant.grantID);
  const consents = await ctx.store.db.selectFrom('oauthConsent').select('id').execute();
  const grants = await collectGrants(ctx.store.db);

  expect(revoked).toBeTrue();
  expect(consents).toStrictEqual([]);
  expect(grants).toStrictEqual([]);
});

test('it reports an unknown grant id as not revoked', async () => {
  const ctx = await setupTest();
  const revoked = await revokeGrant(ctx.store.db, 'unknown-grant');

  expect(revoked).toBeFalse();
});

test("it never removes another grant's tokens or another client's consent", async () => {
  const ctx = await setupTest();

  const revoked = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const kept = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Cursor', redirectURIs: ['https://cursor.com/oauth/callback'] },
  });

  for (const client of [
    { clientID: revoked.clientID, redirectURI: 'https://claude.ai/api/mcp/auth_callback' },
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

  const revokedGrant = grants.find((grant) => grant.clientID === revoked.clientID);
  const keptGrant = grants.find((grant) => grant.clientID === kept.clientID);

  invariant(revokedGrant !== undefined && keptGrant !== undefined, 'the exchanges left no grants');

  await revokeGrant(ctx.store.db, revokedGrant.grantID);

  const accessTokens = await ctx.store.db
    .selectFrom('oauthAccessToken')
    .select('authorizationCodeId')
    .execute();

  const refreshTokens = await ctx.store.db
    .selectFrom('oauthRefreshToken')
    .select('authorizationCodeId')
    .execute();

  const consents = await ctx.store.db.selectFrom('oauthConsent').select('clientId').execute();

  expect(accessTokens).toStrictEqual([{ authorizationCodeId: keptGrant.grantID }]);
  expect(refreshTokens).toStrictEqual([{ authorizationCodeId: keptGrant.grantID }]);
  expect(consents).toStrictEqual([{ clientId: kept.clientID }]);
});
