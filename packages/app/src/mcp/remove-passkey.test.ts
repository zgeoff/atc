import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { removePasskey } from './remove-passkey';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-remove-passkey-');

  const store = await openMCPAuth({
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it removes the passkey and every browser sign-in', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values([
      {
        id: 'cred-lost',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:00:00.000Z',
        last_used_at: null,
      },
      {
        id: 'cred-kept',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:00:00.000Z',
        last_used_at: null,
      },
    ])
    .execute();

  await ctx.auth.api.signInOwner({ body: {} });

  const signedInBefore = await ctx.db.selectFrom('session').select('id').execute();

  invariant(signedInBefore.length === 1, 'the arrangement left no browser sign-in');

  const removed = await removePasskey(ctx.db, 'cred-lost');

  expect(removed).toBeTrue();

  const passkeyRows = await ctx.db.selectFrom('atc_passkey').select('id').execute();

  expect(passkeyRows).toStrictEqual([{ id: 'cred-kept' }]);

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toBeEmpty();
});

test('it removes nothing and keeps every browser sign-in for an unknown passkey', async () => {
  const ctx = await setupTest();

  await ctx.auth.api.signInOwner({ body: {} });

  const removed = await removePasskey(ctx.db, 'cred-missing');

  expect(removed).toBeFalse();

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toBeArrayOfSize(1);
});
