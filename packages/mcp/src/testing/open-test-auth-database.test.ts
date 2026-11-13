import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from './open-test-auth-database';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-test-auth-db-');

  return { path: join(temporaryDirectory.path, 'mcp-auth.db') };
}

test('it opens the database with foreign keys enforced', () => {
  const ctx = setupTest();
  const sqlite = openTestAuthDatabase(ctx.path);

  onTestFinished(() => {
    sqlite.close();
  });

  expect(sqlite.query('PRAGMA foreign_keys').get()).toStrictEqual({ foreign_keys: 1 });
});

test('it releases the file once closed, so another connection writes to it', () => {
  const ctx = setupTest();
  const sqlite = openTestAuthDatabase(ctx.path);

  sqlite.run('CREATE TABLE note (id TEXT)');
  sqlite.close();

  const other = new Database(ctx.path);

  onTestFinished(() => {
    other.close();
  });

  other.run("INSERT INTO note (id) VALUES ('n1')");

  expect(other.query('SELECT id FROM note').all()).toStrictEqual([{ id: 'n1' }]);
});
