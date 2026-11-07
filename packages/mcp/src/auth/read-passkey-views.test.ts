import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildSeeder } from '../test-utils/build-seeder';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { readPasskeyViews } from './read-passkey-views';
import { updatePasskeyUse } from './update-passkey-use';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-collect-passkeys-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const deps = { db: store.db, clock: buildStubClock(Date.UTC(2026, 9, 14, 12, 0, 0)) };

  return { ...deps, auth: store.auth, seed: buildSeeder(deps) };
}

test('it lists the passkeys oldest first', async () => {
  const ctx = await setupTest();

  await ctx.seed.passkey({ id: 'cred-new', counter: 3, now: Date.UTC(2026, 9, 14, 13, 0, 0) });
  await ctx.seed.passkey({ id: 'cred-old' });

  await updatePasskeyUse(ctx.db, {
    id: 'cred-new',
    counter: 3,
    newCounter: 4,
    now: Date.UTC(2026, 9, 14, 14, 0, 0),
  });

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
