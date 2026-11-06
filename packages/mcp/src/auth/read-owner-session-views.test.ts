import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { readOwnerSessionViews } from './read-owner-session-views';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-read-owner-sessions-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it lists the browser sign-in an owner login starts, with when it expires', async () => {
  const ctx = await setupTest();

  await ctx.auth.api.signInOwner({ body: {} });

  const sessions = await readOwnerSessionViews(ctx.db);

  expect(sessions).toStrictEqual([{ id: expect.any(String), expiresAt: expect.toBeDateString() }]);
});

test('it lists nothing when no one is signed in', async () => {
  const ctx = await setupTest();
  const sessions = await readOwnerSessionViews(ctx.db);

  expect(sessions).toStrictEqual([]);
});
