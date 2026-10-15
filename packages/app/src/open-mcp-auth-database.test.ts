import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { Kysely, sql } from 'kysely';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

// A temp directory for the database, and a Kysely instance over the opened
// file, destroyed before the file closes.
function setupTest() {
  const tmp = setupTempDir('atc-mcp-auth-database-');
  const database = openMCPAuthDatabase(join(tmp.dir, 'mcp-auth.db'));

  registerTestCleanup(() => {
    database.close();
  });

  const db = new Kysely<Record<string, never>>({ dialect: database.dialect });

  registerTestCleanup(() => db.destroy());

  return { db };
}

test('it opens the database with foreign keys enforced', async () => {
  const ctx = setupTest();

  const pragma = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(ctx.db);

  expect(pragma.rows).toStrictEqual([{ foreign_keys: 1 }]);
});

test('it opens the database to wait for another process lock before failing', async () => {
  const ctx = setupTest();

  const pragma = await sql<{ timeout: number }>`pragma busy_timeout`.execute(ctx.db);

  expect(pragma.rows).toStrictEqual([{ timeout: 5000 }]);
});
