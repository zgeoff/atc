import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { openMCPAuthDatabase } from '../../app/src/open-mcp-auth-database';
import { openTestAuthAdmin } from '../../app/src/test-utils/open-test-auth-admin';
import { startMCPHTTPServer } from '../../mcp/src/http/start-mcp-http-server';
import { createTransportCaller } from '../../mcp/src/tools/create-transport-caller';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { registerTestCleanup } from './register-test-cleanup';
import { runPasskeyEnrollment } from './run-passkey-enrollment';
import { setupTempDir } from './setup-temp-dir';

// The MCP HTTP server and its authorization database, opened the way
// `atc passkeys` opens it. Enrollment never reaches the daemon, so the
// caller points at a socket nothing listens on and never dials it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-passkey-enrollment-');
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

  const store = await openTestAuthAdmin(dbPath);

  return { url: server.url, origin: server.origin, store };
}

test("it enrolls the authenticator's passkey with the token", async () => {
  const ctx = await setupTest();

  const authenticator = buildStubAuthenticator();
  const enrollment = { token: await ctx.store.admin.passkeys.createEnrollmentToken() };

  await runPasskeyEnrollment(ctx, enrollment.token, authenticator);

  const passkeys = await ctx.store.admin.passkeys.list();

  expect(passkeys).toMatchObject([{ id: authenticator.credentialID }]);
});

test('it throws when the token does not reach the passkey prompt', async () => {
  const ctx = await setupTest();

  const enrolling = runPasskeyEnrollment(ctx, 'atc-enroll-unknown', buildStubAuthenticator());

  expect(enrolling).rejects.toThrowWithMessage(
    Error,
    'the enrollment token did not reach the passkey prompt: 400',
  );
});

test('it throws when the passkey does not enroll', async () => {
  const ctx = await setupTest();

  const enrollment = { token: await ctx.store.admin.passkeys.createEnrollmentToken() };

  const enrolling = runPasskeyEnrollment(ctx, enrollment.token, {
    create: (options) =>
      buildStubAuthenticator().create(options, { origin: 'https://elsewhere.example' }),
  });

  expect(enrolling).rejects.toThrowWithMessage(Error, /^the passkey did not enroll: 400 /u);
});
