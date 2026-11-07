import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createEnrollmentToken } from './create-enrollment-token';
import { createPasskey } from './create-passkey';
import { deriveTokenHash } from './derive-token-hash';
import { openMCPAuth } from './open-mcp-auth';
import { readPasskeyViews } from './read-passkey-views';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-create-passkey-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it stores the passkey and spends its token', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.db, Date.UTC(2026, 9, 14, 12, 0, 0));

  const created = await createPasskey(ctx.db, {
    tokenHash: deriveTokenHash(enrollment.token),
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

  const passkeys = await readPasskeyViews(ctx.db);

  expect(passkeys).toBeEmpty();
});

test('it stores nothing for a token that expired', async () => {
  const ctx = await setupTest();
  const enrollment = await createEnrollmentToken(ctx.db, Date.UTC(2026, 9, 14, 12, 0, 0));

  const created = await createPasskey(ctx.db, {
    tokenHash: deriveTokenHash(enrollment.token),
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: [],
    now: Date.UTC(2026, 9, 14, 12, 15, 0),
  });

  expect(created).toBeFalse();

  const passkeys = await readPasskeyViews(ctx.db);

  expect(passkeys).toBeEmpty();
});

test('it keeps the token when the passkey is already enrolled', async () => {
  const ctx = await setupTest();
  const first = await createEnrollmentToken(ctx.db, Date.UTC(2026, 9, 14, 12, 0, 0));
  const second = await createEnrollmentToken(ctx.db, Date.UTC(2026, 9, 14, 12, 0, 0));

  const passkey = {
    id: 'cred-1',
    publicKey: 'AQID',
    counter: 0,
    transports: [],
    now: Date.UTC(2026, 9, 14, 12, 5, 0),
  };

  await createPasskey(ctx.db, { ...passkey, tokenHash: deriveTokenHash(first.token) });

  expect(
    createPasskey(ctx.db, { ...passkey, tokenHash: deriveTokenHash(second.token) }),
  ).rejects.toThrow();

  const tokenRows = await ctx.db.selectFrom('atc_enrollment_token').select('token_hash').execute();

  expect(tokenRows).toStrictEqual([{ token_hash: deriveTokenHash(second.token) }]);
});
