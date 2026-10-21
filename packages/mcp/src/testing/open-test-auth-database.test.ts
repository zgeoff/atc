import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { Kysely, sql } from 'kysely';
import { openTestAuthDatabase } from './open-test-auth-database';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-test-auth-db-');

  return { path: join(temporaryDirectory.path, 'mcp-auth.db') };
}

test('it opens the database with foreign keys enforced', async () => {
  const ctx = setupTest();
  const database = openTestAuthDatabase(ctx.path);

  const db = new Kysely({ dialect: database.dialect });

  onTestFinished(() => db.destroy());

  const result = await sql`PRAGMA foreign_keys`.execute(db);

  expect(result.rows).toStrictEqual([{ foreign_keys: 1 }]);
});

test('it releases the file once closed, so another connection writes to it', async () => {
  const ctx = setupTest();
  const database = openTestAuthDatabase(ctx.path);

  const db = new Kysely({ dialect: database.dialect });

  await sql`CREATE TABLE note (id TEXT)`.execute(db);
  await db.destroy();

  database.close();

  const other = new Database(ctx.path);

  onTestFinished(() => {
    other.close();
  });

  other.run("INSERT INTO note (id) VALUES ('n1')");

  expect(other.query('SELECT id FROM note').all()).toStrictEqual([{ id: 'n1' }]);
});
