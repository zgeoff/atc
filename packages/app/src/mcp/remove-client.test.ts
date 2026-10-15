import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/wire';
import {
  buildStubAuthenticator,
  registerTestCleanup,
  runMCPAuthorization,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { collectClients } from './collect-clients';
import { collectGrants } from './collect-grants';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { removeClient } from './remove-client';
import { startMCPHTTPServer } from './start-mcp-http-server';
import { TransportCaller } from './transport-caller';

// `atc mcp --http` on a free port with the owner's passkey enrolled, and its authorization server's database opened a second time
// the way `atc clients` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const tmp = setupTempDir('atc-remove-client-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');

  const caller = new TransportCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
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
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  return { url: server.url, origin: server.origin, authenticator, store };
}

test('it removes a client and reports it removed', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const removed = await removeClient(ctx.store.db, created.clientID);

  expect(removed).toBeTrue();
  expect(collectClients(ctx.store.db)).resolves.toStrictEqual([]);
});

test('it reports an unknown client id as not removed', async () => {
  const ctx = await setupTest();
  const removed = await removeClient(ctx.store.db, 'unknown-client');

  expect(removed).toBeFalse();
});

test("it never removes another client's tokens, consent or grant use", async () => {
  const ctx = await setupTest();

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

  const accessTokens = await ctx.store.db
    .selectFrom('oauthAccessToken')
    .select('clientId')
    .execute();

  const refreshTokens = await ctx.store.db
    .selectFrom('oauthRefreshToken')
    .select('clientId')
    .execute();

  const consents = await ctx.store.db.selectFrom('oauthConsent').select('clientId').execute();
  const grantUses = await ctx.store.db.selectFrom('atc_grant_use').select('grant_id').execute();

  expect(accessTokens).toStrictEqual([{ clientId: kept.clientID }]);
  expect(refreshTokens).toStrictEqual([{ clientId: kept.clientID }]);
  expect(consents).toStrictEqual([{ clientId: kept.clientID }]);
  expect(grantUses).toStrictEqual([{ grant_id: keptGrant.grantID }]);
});
