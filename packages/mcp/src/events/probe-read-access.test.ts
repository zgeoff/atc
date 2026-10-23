import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildStubAuthenticator,
  readJSONRecord,
  registerTestCleanup,
  runMCPAuthorization,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
import { createEnrollmentToken } from '../auth/create-enrollment-token';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';
import { probeReadAccess } from './probe-read-access';

// `atc mcp --http` with the owner's passkey enrolled, and its authorization
// database opened a second time. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-probe-read-access-');
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

test('it finds read access for a client with a live grant that holds read', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  expect(probeReadAccess(ctx.store.db, created.clientID)).resolves.toBeTrue();
});

test('it finds no read access once the client revokes its refresh token itself', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await fetch(`${ctx.url}/oauth2/revoke`, {
    method: 'POST',
    body: new URLSearchParams({
      token: String(tokens['refresh_token']),
      token_type_hint: 'refresh_token',
      client_id: created.clientID,
    }),
  });

  expect(probeReadAccess(ctx.store.db, created.clientID)).resolves.toBeFalse();
});

test('it finds no read access for a client whose grant holds only another scope', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'message',
    ticked: ['message'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  expect(probeReadAccess(ctx.store.db, created.clientID)).resolves.toBeFalse();
});
