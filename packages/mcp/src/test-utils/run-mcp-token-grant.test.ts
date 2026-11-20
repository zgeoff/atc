import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { createDaemonClient } from '@atc/protocol/client';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { createTransportCaller } from '../tools/create-transport-caller';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { openTestAuthAdmin } from './open-test-auth-admin';
import { openTestAuthDatabase } from './open-test-auth-database';
import { runMCPTokenGrant } from './run-mcp-token-grant';
import { runPasskeyEnrollment } from './run-passkey-enrollment';

// A token grant never reaches the daemon, so the caller points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-mcp-token-grant-');
  const dbPath = join(temporaryDirectory.path, 'mcp-auth.db');

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => createDaemonClient(path),
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

  const store = await openTestAuthAdmin(dbPath);

  const authenticator = buildStubAuthenticator();
  const enrollment = { token: await store.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  return { url: server.url, origin: server.origin, authenticator, store };
}

test('it returns an access token that holds the ticked scopes', async () => {
  const ctx = await setupTest();
  const created = await ctx.store.admin.clients.add('dots', ['https://dots.example/cb']);

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read spawn',
    ticked: ['read'],
  });

  const answered = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${grant.accessToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(grant.scope).toBe('read offline_access');
  expect(answered.status).toBe(200);
});
