import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { updatePasskeyUse } from './update-passkey-use';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-update-passkey-use-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db };
}

test('it stores the new counter and the time of the use', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 4,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  const stored = await updatePasskeyUse(ctx.db, {
    id: 'cred-phone',
    counter: 4,
    newCounter: 5,
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(stored).toBeTrue();

  expect(
    ctx.db.selectFrom('atc_passkey').select(['counter', 'last_used_at']).execute(),
  ).resolves.toStrictEqual([{ counter: 5, last_used_at: '2026-10-14T13:00:00.000Z' }]);
});

test('it stores nothing when the passkey holds another counter than the verification read', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 6,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  const stored = await updatePasskeyUse(ctx.db, {
    id: 'cred-phone',
    counter: 4,
    newCounter: 5,
    now: Date.UTC(2026, 9, 14, 13, 0, 0),
  });

  expect(stored).toBeFalse();

  expect(
    ctx.db.selectFrom('atc_passkey').select(['counter', 'last_used_at']).execute(),
  ).resolves.toStrictEqual([{ counter: 6, last_used_at: null }]);
});

test('it stores nothing for a passkey that is no longer enrolled', async () => {
  const ctx = await setupTest();

  expect(
    updatePasskeyUse(ctx.db, { id: 'cred-gone', counter: 0, newCounter: 1, now: 0 }),
  ).resolves.toBeFalse();
});
