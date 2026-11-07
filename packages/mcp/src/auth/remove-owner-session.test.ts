import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { removeOwnerSession } from './remove-owner-session';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remove-owner-session-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it removes only the owner session it is given', async () => {
  const ctx = await setupTest();

  await ctx.auth.api.signInOwner({ body: {} });
  await ctx.auth.api.signInOwner({ body: {} });

  const [removed, kept] = await ctx.db.selectFrom('session').select('id').execute();

  invariant(removed !== undefined && kept !== undefined, 'the arrangement left no two sessions');

  await removeOwnerSession(ctx.db, removed.id);

  const sessions = await ctx.db.selectFrom('session').select('id').execute();

  expect(sessions).toStrictEqual([{ id: kept.id }]);
});
