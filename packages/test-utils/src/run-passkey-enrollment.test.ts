import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { createEnrollmentToken } from '../../app/src/mcp/create-enrollment-token';
import { openMCPAuth } from '../../app/src/mcp/open-mcp-auth';
import { readPasskeyViews } from '../../app/src/mcp/read-passkey-views';
import { startMCPHTTPServer } from '../../app/src/mcp/start-mcp-http-server';
import { TransportCaller } from '../../app/src/mcp/transport-caller';
import { openMCPAuthDatabase } from '../../app/src/open-mcp-auth-database';
import { buildStubAuthenticator } from './build-stub-authenticator';
import { registerTestCleanup } from './register-test-cleanup';
import { runPasskeyEnrollment } from './run-passkey-enrollment';
import { setupTempDir } from './setup-temp-dir';

// The MCP HTTP server and its authorization database, opened the way
// `atc passkeys` opens it. Enrollment never reaches the daemon, so the
// caller points at a socket nothing listens on and never dials it.
async function setupTest() {
  const tmp = setupTempDir('atc-run-passkey-enrollment-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');

  const caller = new TransportCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    openDaemonClient(path),
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

  return { url: server.url, origin: server.origin, store };
}

test("it enrolls the authenticator's passkey with the token", async () => {
  const ctx = await setupTest();

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(ctx.store.db, Date.now());

  await runPasskeyEnrollment(ctx, enrollment.token, authenticator);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toStrictEqual([
    { id: authenticator.credentialID, createdAt: expect.toBeString(), lastUsedAt: null },
  ]);
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
  const enrollment = await createEnrollmentToken(ctx.store.db, Date.now());

  const enrolling = runPasskeyEnrollment(ctx, enrollment.token, {
    create: (options) =>
      buildStubAuthenticator().create(options, { origin: 'https://elsewhere.example' }),
  });

  expect(enrolling).rejects.toThrowWithMessage(Error, /^the passkey did not enroll: 400 /u);
});
