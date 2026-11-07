import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { systemClock } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildStubAuthenticator,
  registerTestCleanup,
  runMCPAuthorization,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { createSubscriptionStore } from '../events/create-subscription-store';
import { readCallbackVerifiedAt } from '../events/read-callback-verified-at';
import { writeCallbackVerifiedAt } from '../events/write-callback-verified-at';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { buildSeeder } from '../test-utils/build-seeder';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { readClientViews } from './read-client-views';
import { readGrantViews } from './read-grant-views';
import { removeClient } from './remove-client';
import { writeGrantUse } from './write-grant-use';

// `atc mcp --http` on a free port with the owner's passkey enrolled, and its authorization server's database opened a second time
// the way `atc clients` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remove-client-');
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

  return {
    url: server.url,
    origin: server.origin,
    authenticator,
    store,
    seed: buildSeeder({ db: store.db, clock: systemClock }),
  };
}

test('it removes a client and reports it removed', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const removed = await removeClient(ctx.store.db, created.clientID);

  expect(removed).toBeTrue();
  expect(readClientViews(ctx.store.db)).resolves.toStrictEqual([]);
});

test("it ends a removed client's event subscriptions", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  await ctx.seed.eventSubscription({ id: 'sub-one', client_id: created.clientID });

  await removeClient(ctx.store.db, created.clientID);

  const subscriptions = await createSubscriptionStore(ctx.store.db).readIDs();

  expect(subscriptions).toStrictEqual([]);
});

test("it removes a removed client's verified callbacks and keeps another client's", async () => {
  const ctx = await setupTest();

  const removed = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const kept = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  await writeCallbackVerifiedAt(ctx.store.db, {
    clientID: removed.clientID,
    url: 'https://hooks.example.com/hook',
    now: Date.UTC(2026, 9, 23, 12, 0, 0),
  });

  await writeCallbackVerifiedAt(ctx.store.db, {
    clientID: kept.clientID,
    url: 'https://hooks.example.com/hook',
    now: Date.UTC(2026, 9, 23, 12, 0, 0),
  });

  await removeClient(ctx.store.db, removed.clientID);

  const removedVerifiedAt = await readCallbackVerifiedAt(
    ctx.store.db,
    removed.clientID,
    'https://hooks.example.com/hook',
  );

  expect(removedVerifiedAt).toBeNull();

  const keptVerifiedAt = await readCallbackVerifiedAt(
    ctx.store.db,
    kept.clientID,
    'https://hooks.example.com/hook',
  );

  expect(keptVerifiedAt).toBe('2026-10-23T12:00:00.000Z');
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

  const grants = await readGrantViews(ctx.store.db);

  for (const grant of grants) {
    await writeGrantUse(ctx.store.db, grant.grantID, Date.UTC(2026, 9, 8, 0, 0, 0));
  }

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
