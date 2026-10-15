import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { resetPasskeys } from './reset-passkeys';
import { verifySessionPasskey } from './verify-session-passkey';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-verify-session-passkey-');

  const store = await openMCPAuth({
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it keeps a session whose signing passkey is still enrolled', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 0,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

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

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 0,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

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

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 0,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  await ctx.auth.api.signInOwner({ body: {} });

  const [session] = await ctx.db.selectFrom('session').select('id').execute();

  invariant(session !== undefined, 'the arrangement left no owner session');

  await ctx.db.deleteFrom('session').execute();

  const kept = await verifySessionPasskey(ctx.db, {
    sessionID: session.id,
    passkeyID: 'cred-phone',
  });

  expect(kept).toBeFalse();
});
