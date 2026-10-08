import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { CompiledQuery } from 'kysely';
import { readQueryPlan } from './read-query-plan';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-query-plan-');
  const dbPath = join(tmp.dir, 'plan.db');

  const db = new Database(dbPath);

  const closeDB = registerTestCleanup(() => {
    db.close();
  });

  // Every test reads a plan over this table and its one index.
  db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT)');
  db.run('CREATE INDEX notes_owner ON notes (owner)');

  closeDB();

  return { dbPath };
}

test('it reads the index a bound query uses from its plan', () => {
  const ctx = setupTest();

  const plan = readQueryPlan(
    ctx.dbPath,
    CompiledQuery.raw('SELECT body FROM notes WHERE owner = ?', ['alice']),
  );

  expect(plan).toInclude('USING INDEX notes_owner');
});

test('it reads a full scan from the plan of a query no index serves', () => {
  const ctx = setupTest();

  const plan = readQueryPlan(
    ctx.dbPath,
    CompiledQuery.raw('SELECT id FROM notes WHERE body = ?', ['groceries']),
  );

  expect(plan).toBe('SCAN notes');
});

test('it never runs the query whose plan it reads', () => {
  const ctx = setupTest();

  readQueryPlan(ctx.dbPath, CompiledQuery.raw("INSERT INTO notes (owner) VALUES ('alice')", []));

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  expect(reader.query('SELECT id FROM notes').all()).toStrictEqual([]);
});
