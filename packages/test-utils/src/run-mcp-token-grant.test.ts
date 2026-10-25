import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { openMCPAuthDatabase } from '../../app/src/open-mcp-auth-database';
import { createEnrollmentToken } from '../../mcp/src/auth/create-enrollment-token';
import { openMCPAuth } from '../../mcp/src/auth/open-mcp-auth';
import { startMCPHTTPServer } from '../../mcp/src/http/start-mcp-http-server';
import { createTransportCaller } from '../../mcp/src/tools/create-transport-caller';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { registerTestCleanup } from './register-test-cleanup';
import { runMCPTokenGrant } from './run-mcp-token-grant';
import { runPasskeyEnrollment } from './run-passkey-enrollment';
import { setupTempDir } from './setup-temp-dir';

// The MCP HTTP server with the owner's passkey enrolled. A grant never
// reaches the daemon, so the caller points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-mcp-token-grant-');
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

test('it returns an access token that holds the ticked scopes', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

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
