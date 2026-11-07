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
import { createEnrollmentToken } from '../auth/create-enrollment-token';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';
import { seedGrantID } from './seed-grant-id';

// `atc mcp --http` on a free port with the owner's passkey enrolled, and its
// authorization database opened a second time. No test reaches the daemon,
// so the caller points at a socket nothing listens on.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-grant-id-');
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

  return { url: server.url, origin: server.origin, authenticator, store, db: store.db };
}

test("it gives the client's access and refresh tokens the grant id it is passed", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
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
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  await seedGrantID(ctx, { clientID: created.clientID, grantID: '-dash_grant' });

  expect(
    ctx.db.selectFrom('oauthAccessToken').select('authorizationCodeId').execute(),
  ).resolves.toStrictEqual([{ authorizationCodeId: '-dash_grant' }]);

  expect(
    ctx.db.selectFrom('oauthRefreshToken').select('authorizationCodeId').execute(),
  ).resolves.toStrictEqual([{ authorizationCodeId: '-dash_grant' }]);
});
