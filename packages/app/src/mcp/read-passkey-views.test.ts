import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { readPasskeyViews } from './read-passkey-views';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-collect-passkeys-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it lists the passkeys oldest first', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_passkey')
    .values([
      {
        id: 'cred-new',
        public_key: 'AQID',
        counter: 3,
        transports: '[]',
        created_at: '2026-10-14T13:00:00.000Z',
        last_used_at: '2026-10-14T14:00:00.000Z',
      },
      {
        id: 'cred-old',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:00:00.000Z',
        last_used_at: null,
      },
    ])
    .execute();

  const passkeys = await readPasskeyViews(ctx.db);

  expect(passkeys).toStrictEqual([
    { id: 'cred-old', createdAt: '2026-10-14T12:00:00.000Z', lastUsedAt: null },
    {
      id: 'cred-new',
      createdAt: '2026-10-14T13:00:00.000Z',
      lastUsedAt: '2026-10-14T14:00:00.000Z',
    },
  ]);
});

test('it lists nothing when no passkey is enrolled', async () => {
  const ctx = await setupTest();
  const passkeys = await readPasskeyViews(ctx.db);

  expect(passkeys).toStrictEqual([]);
});
