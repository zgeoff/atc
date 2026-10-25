import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildStubAuthenticator,
  registerTestCleanup,
  runMCPAuthorization,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { readGrantViews } from './read-grant-views';
import { revokeGrant } from './revoke-grant';

// `atc mcp --http` on a free port with the owner's passkey enrolled, and its authorization server's database opened a second time
// the way `atc grants` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-revoke-grant-');
  const dbPath = join(temporaryDirectory.path, 'mcp-auth.db');

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openTestAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openTestAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  return { url: server.url, origin: server.origin, authenticator, store };
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

  const [grant] = await readGrantViews(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  const revoked = await revokeGrant(ctx.store.db, grant.grantID, Date.now());
  const consents = await ctx.store.db.selectFrom('oauthConsent').select('id').execute();
  const grants = await readGrantViews(ctx.store.db);

  expect(revoked).toBeTrue();
  expect(consents).toStrictEqual([]);
  expect(grants).toStrictEqual([]);
});

test("it ends the client's event subscriptions along with its last read grant", async () => {
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

  await ctx.store.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub-one',
      client_id: clientID,
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-1',
      refresh_before: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const [grant] = await readGrantViews(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  await revokeGrant(ctx.store.db, grant.grantID, Date.now());

  const subscriptions = await ctx.store.db
    .selectFrom('atc_event_subscription')
    .select('id')
    .execute();

  expect(subscriptions).toStrictEqual([]);
});

test("it keeps the client's event subscriptions while another read grant lives", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const first = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: first.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: first.verifier,
    }),
  });

  const second = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: second.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: second.verifier,
    }),
  });

  await ctx.store.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub-one',
      client_id: clientID,
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-1',
      refresh_before: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const [grant] = await readGrantViews(ctx.store.db);

  invariant(grant !== undefined, 'the exchanges left no grant');

  await revokeGrant(ctx.store.db, grant.grantID, Date.now());

  const subscriptions = await ctx.store.db
    .selectFrom('atc_event_subscription')
    .select('id')
    .execute();

  expect(subscriptions).toStrictEqual([{ id: 'sub-one' }]);
});

test('it reports an unknown grant id as not revoked', async () => {
  const ctx = await setupTest();
  const revoked = await revokeGrant(ctx.store.db, 'unknown-grant', Date.now());

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

  const grants = await readGrantViews(ctx.store.db);

  const revokedGrant = grants.find((grant) => grant.clientID === revoked.clientID);
  const keptGrant = grants.find((grant) => grant.clientID === kept.clientID);

  invariant(revokedGrant !== undefined && keptGrant !== undefined, 'the exchanges left no grants');

  await revokeGrant(ctx.store.db, revokedGrant.grantID, Date.now());

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
