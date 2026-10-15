import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { Kysely, sql } from 'kysely';
import { buildSQLiteDialect } from './build-sqlite-dialect';
import { openSQLite } from './open-sqlite';
import { withImmediateTransaction } from './with-immediate-transaction';

function setupTest() {
  const tmp = setupTempDir('atc-immediate-');
  const sqlite = openSQLite(join(tmp.dir, 'state.db'));

  const db = new Kysely<Record<string, never>>({ dialect: buildSQLiteDialect(sqlite) });

  registerTestCleanup(async () => {
    await db.destroy();

    sqlite.close();
  });

  return { sqlite, db };
}

test('it keeps the writes of a callback that returns', async () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');

  await withImmediateTransaction(ctx.db, async () => {
    await sql`INSERT INTO notes (title) VALUES ('kept')`.execute(ctx.db);
  });

  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([{ title: 'kept' }]);
});

test('it drops the writes of a callback that throws and rethrows its error', () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');

  const run = withImmediateTransaction(ctx.db, async () => {
    await sql`INSERT INTO notes (title) VALUES ('dropped')`.execute(ctx.db);

    throw new Error('rebuild failed');
  });

  expect(run).rejects.toThrowWithMessage(Error, 'rebuild failed');
  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([]);
});

test('it rolls back a table rebuild whose callback throws', () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');

  const run = withImmediateTransaction(ctx.db, async () => {
    await sql`ALTER TABLE notes RENAME TO notes_old`.execute(ctx.db);

    throw new Error('rebuild failed');
  });

  expect(run).rejects.toThrow();

  expect(
    ctx.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
  ).toStrictEqual([{ name: 'notes' }]);
});

test('it rethrows the error of a callback whose transaction SQLite already ended', () => {
  const ctx = setupTest();

  // The callback ends the transaction itself, as SQLite does after a full
  // disk, so the helper's own rollback finds no transaction to end.
  const run = withImmediateTransaction(ctx.db, async () => {
    await sql`ROLLBACK`.execute(ctx.db);

    throw new Error('disk full');
  });

  expect(run).rejects.toThrowWithMessage(Error, 'disk full');
});
