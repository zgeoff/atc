import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { resetPasskeys } from './reset-passkeys';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-reset-passkeys-');

  const store = await openMCPAuth({
    dbPath: join(tmp.path, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it removes every passkey, enrollment token, and browser sign-in', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-lost',
      public_key: 'AQID',
      counter: 0,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  await ctx.db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: 'hash-1',
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    .execute();

  await ctx.auth.api.signInOwner({ body: {} });

  const signedInBefore = await ctx.db.selectFrom('session').select('id').execute();

  invariant(signedInBefore.length === 1, 'the arrangement left no browser sign-in');

  await resetPasskeys(ctx.db);

  const passkeyRows = await ctx.db.selectFrom('atc_passkey').select('id').execute();

  expect(passkeyRows).toBeEmpty();

  const tokenRows = await ctx.db.selectFrom('atc_enrollment_token').select('token_hash').execute();

  expect(tokenRows).toBeEmpty();

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toBeEmpty();
});

test('it never removes a client', async () => {
  const ctx = await setupTest();

  await ctx.auth.api.createFixedClient({
    body: { name: 'dots', redirectURIs: ['https://dots.example/cb'] },
  });

  await resetPasskeys(ctx.db);

  const clients = await ctx.db.selectFrom('oauthClient').select('name').execute();

  expect(clients).toStrictEqual([{ name: 'dots' }]);
});
