import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/wire';
import { createEnrollmentToken } from '../../app/src/mcp/create-enrollment-token';
import { openMCPAuth } from '../../app/src/mcp/open-mcp-auth';
import { startMCPHTTPServer } from '../../app/src/mcp/start-mcp-http-server';
import { TransportCaller } from '../../app/src/mcp/transport-caller';
import { openMCPAuthDatabase } from '../../app/src/open-mcp-auth-database';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { registerTestCleanup } from './register-test-cleanup';
import { runPasskeyEnrollment } from './run-passkey-enrollment';
import { runPasskeySignIn } from './run-passkey-sign-in';
import { setupTempDir } from './setup-temp-dir';

async function setupTest() {
  const tmp = setupTempDir('atc-run-passkey-sign-in-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');

  // Sign-in never reaches the daemon, so the caller points at a socket nothing
  // listens on and never dials it.
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

test('it signs in for the request the login page belongs to and lands on its consent page', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  expect(signedIn.status).toBe(302);
  expect(new URL(signedIn.headers.get('location') ?? '/').pathname).toBe('/consent');
});

test('it sends the ceremony values it is given in place of the honest ones', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login, { origin: 'https://elsewhere.example' });

  expect(signedIn.status).toBe(400);
});

test('it throws when the page holds no sign-in ceremony', async () => {
  const ctx = await setupTest();

  const signingIn = runPasskeySignIn(ctx, new URL(`${ctx.url}/login?client_id=unknown`));

  expect(signingIn).rejects.toThrowWithMessage(Error, 'the page holds no passkey ceremony');
});
