import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { openDaemonClient } from '@atc/protocol/client';
import { startMCPHTTPServer } from '../http/start-mcp-http-server';
import { createTransportCaller } from '../tools/create-transport-caller';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { openTestAuthAdmin } from './open-test-auth-admin';
import { openTestAuthDatabase } from './open-test-auth-database';
import { runMCPTokenGrant } from './run-mcp-token-grant';
import { runPasskeyEnrollment } from './run-passkey-enrollment';
import { sendModernMCPRequest } from './send-modern-mcp-request';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-send-modern-mcp-request-');
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

  const store = await openTestAuthAdmin(dbPath);

  const authenticator = buildStubAuthenticator();
  const enrollment = { token: await store.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  return { url: server.url, origin: server.origin, authenticator, store };
}

test('it sends a request the server serves in the stateless revision', async () => {
  const ctx = await setupTest();
  const created = await ctx.store.admin.clients.add('dots', ['https://dots.example/cb']);

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'server/discover');

  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ result: { supportedVersions: ['2026-07-28'] } });
});

test('it names the tool of a tool call in its headers, as the stateless revision requires', async () => {
  const ctx = await setupTest();
  const created = await ctx.store.admin.clients.add('dots', ['https://dots.example/cb']);

  const grant = await runMCPTokenGrant(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['read'],
  });

  const answer = await sendModernMCPRequest(ctx.url, grant.accessToken, 'tools/call', {
    name: 'atc_recent_dirs_list',
    arguments: {},
  });

  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ result: { resultType: 'complete' } });
});
