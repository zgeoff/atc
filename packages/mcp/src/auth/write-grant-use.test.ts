import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { writeGrantUse } from './write-grant-use';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-write-grant-use-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db };
}

test('it records when a grant was last used', async () => {
  const ctx = await setupTest();

  await writeGrantUse(ctx.db, 'grant-one', Date.UTC(2026, 9, 8, 0, 0, 0));

  const rows = await ctx.db.selectFrom('atc_grant_use').selectAll().execute();

  expect(rows).toStrictEqual([{ grant_id: 'grant-one', last_used_at: '2026-10-08T00:00:00.000Z' }]);
});

test('it moves the last-used time of a grant used again', async () => {
  const ctx = await setupTest();

  await writeGrantUse(ctx.db, 'grant-one', Date.UTC(2026, 9, 8, 0, 0, 0));
  await writeGrantUse(ctx.db, 'grant-one', Date.UTC(2026, 9, 9, 0, 0, 0));

  const rows = await ctx.db.selectFrom('atc_grant_use').selectAll().execute();

  expect(rows).toStrictEqual([{ grant_id: 'grant-one', last_used_at: '2026-10-09T00:00:00.000Z' }]);
});
