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
import { runPasskeyEnrollment } from './run-passkey-enrollment';

// Passkey enrollment never reaches the daemon, so the caller points at a socket
// nothing listens on and never dials it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-passkey-enrollment-');
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
