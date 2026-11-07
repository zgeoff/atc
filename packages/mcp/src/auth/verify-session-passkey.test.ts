import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildSeeder } from '../test-utils/build-seeder';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { removeOwnerSession } from './remove-owner-session';
import { resetPasskeys } from './reset-passkeys';
import { verifySessionPasskey } from './verify-session-passkey';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-verify-session-passkey-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const deps = { db: store.db, clock: buildStubClock(Date.UTC(2026, 9, 14, 12, 0, 0)) };

  return { ...deps, auth: store.auth, seed: buildSeeder(deps) };
}

test('it keeps a session whose signing passkey is still enrolled', async () => {
  const ctx = await setupTest();

  await ctx.seed.passkey({ id: 'cred-phone' });
  await ctx.auth.api.signInOwner({ body: {} });

  const [session] = await ctx.db.selectFrom('session').select('id').execute();

  invariant(session !== undefined, 'the arrangement left no owner session');

  const kept = await verifySessionPasskey(ctx.db, {
    sessionID: session.id,
    passkeyID: 'cred-phone',
  });

  expect(kept).toBeTrue();

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toStrictEqual([{ id: session.id }]);
});

test('it removes a session created after a reset deleted its signing passkey', async () => {
  const ctx = await setupTest();

  await ctx.seed.passkey({ id: 'cred-phone' });

  await resetPasskeys(ctx.db);

  await ctx.auth.api.signInOwner({ body: {} });

  const [session] = await ctx.db.selectFrom('session').select('id').execute();

  invariant(session !== undefined, 'the arrangement left no owner session');

  const kept = await verifySessionPasskey(ctx.db, {
    sessionID: session.id,
    passkeyID: 'cred-phone',
  });

  expect(kept).toBeFalse();

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toBeEmpty();
});

test('it refuses a session deleted before the check while its passkey stays enrolled', async () => {
  const ctx = await setupTest();

  await ctx.seed.passkey({ id: 'cred-phone' });
  await ctx.auth.api.signInOwner({ body: {} });

  const [session] = await ctx.db.selectFrom('session').select('id').execute();

  invariant(session !== undefined, 'the arrangement left no owner session');

  await removeOwnerSession(ctx.db, session.id);

  const kept = await verifySessionPasskey(ctx.db, {
    sessionID: session.id,
    passkeyID: 'cred-phone',
  });

  expect(kept).toBeFalse();
});
