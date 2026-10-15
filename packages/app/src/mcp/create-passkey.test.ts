import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { collectPasskeys } from './collect-passkeys';
import { createPasskey } from './create-passkey';
import { openMCPAuth } from './open-mcp-auth';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-create-passkey-');

  const store = await openMCPAuth({
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it stores the passkey and spends its token', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: 'hash-1',
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2026-10-14T12:15:00.000Z',
    })
    .execute();

  const created = await createPasskey(ctx.db, {
    tokenHash: 'hash-1',
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: ['internal', 'hybrid'],
    now: Date.UTC(2026, 9, 14, 12, 5, 0),
  });

  expect(created).toBeTrue();

  const passkeyRows = await ctx.db.selectFrom('atc_passkey').selectAll().execute();

  expect(passkeyRows).toStrictEqual([
    {
      id: 'cred-1',
      public_key: 'AQID',
      counter: 0,
      transports: '["internal","hybrid"]',
      created_at: '2026-10-14T12:05:00.000Z',
      last_used_at: null,
    },
  ]);

  const tokenRows = await ctx.db.selectFrom('atc_enrollment_token').selectAll().execute();

  expect(tokenRows).toBeEmpty();
});

test('it stores nothing for a token that is spent', async () => {
  const ctx = await setupTest();

  const created = await createPasskey(ctx.db, {
    tokenHash: 'hash-spent',
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: [],
    now: Date.UTC(2026, 9, 14, 12, 5, 0),
  });

  expect(created).toBeFalse();

  const passkeys = await collectPasskeys(ctx.db);

  expect(passkeys).toBeEmpty();
});

test('it stores nothing for a token that expired', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: 'hash-1',
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2026-10-14T12:15:00.000Z',
    })
    .execute();

  const created = await createPasskey(ctx.db, {
    tokenHash: 'hash-1',
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: [],
    now: Date.UTC(2026, 9, 14, 12, 15, 0),
  });

  expect(created).toBeFalse();

  const passkeys = await collectPasskeys(ctx.db);

  expect(passkeys).toBeEmpty();
});

test('it keeps the token when the passkey is already enrolled', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_enrollment_token')
    .values([
      {
        token_hash: 'hash-1',
        created_at: '2026-10-14T12:00:00.000Z',
        expires_at: '2026-10-14T12:15:00.000Z',
      },
      {
        token_hash: 'hash-2',
        created_at: '2026-10-14T12:00:00.000Z',
        expires_at: '2026-10-14T12:15:00.000Z',
      },
    ])
    .execute();

  const passkey = {
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: [],
    now: Date.UTC(2026, 9, 14, 12, 5, 0),
  };

  await createPasskey(ctx.db, { ...passkey, tokenHash: 'hash-1' });

  expect(createPasskey(ctx.db, { ...passkey, tokenHash: 'hash-2' })).rejects.toThrow();

  const tokenRows = await ctx.db.selectFrom('atc_enrollment_token').select('token_hash').execute();

  expect(tokenRows).toStrictEqual([{ token_hash: 'hash-2' }]);
});
