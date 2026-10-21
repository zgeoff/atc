import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMigratedStateDB } from './create-migrated-state-db';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { updateEnv } from './update-env';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-migrated-state-');

  return { directory: temporaryDirectory.path };
}

test('it creates a database with the migration ledger of the run template', () => {
  const ctx = setupTest();
  const dbPath = join(ctx.directory, 'state.db');

  createMigratedStateDB(dbPath);

  const template = new Database(process.env['ATC_TEST_STATE_TEMPLATE'], { readonly: true });

  registerTestCleanup(() => {
    template.close();
  });

  const copy = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    copy.close();
  });

  expect(copy.query('SELECT name FROM kysely_migration ORDER BY name').all()).toStrictEqual(
    template.query('SELECT name FROM kysely_migration ORDER BY name').all(),
  );
});

test('it draws a daemon id for each database that differs from the template', () => {
  const ctx = setupTest();
  const firstPath = join(ctx.directory, 'first.db');
  const secondPath = join(ctx.directory, 'second.db');

  createMigratedStateDB(firstPath);
  createMigratedStateDB(secondPath);

  const template = new Database(process.env['ATC_TEST_STATE_TEMPLATE'], { readonly: true });

  registerTestCleanup(() => {
    template.close();
  });

  const first = new Database(firstPath, { readonly: true });

  registerTestCleanup(() => {
    first.close();
  });

  const second = new Database(secondPath, { readonly: true });

  registerTestCleanup(() => {
    second.close();
  });

  const rows = [template, first, second].map((db) =>
    JSON.stringify(db.query("SELECT value FROM prefs WHERE key = 'daemon_id'").all()),
  );

  expect(new Set(rows).size).toBe(3);
  expect(rows).toSatisfyAll((row: string) => /^\[\{"value":"[\da-f-]{36}"\}\]$/u.test(row));
});

test('it creates a separate file for each call', () => {
  const ctx = setupTest();
  const firstPath = join(ctx.directory, 'first.db');
  const secondPath = join(ctx.directory, 'second.db');

  createMigratedStateDB(firstPath);
  createMigratedStateDB(secondPath);

  const first = new Database(firstPath);

  registerTestCleanup(() => {
    first.close();
  });

  first.run("INSERT INTO prefs (key, value) VALUES ('last_used_agent', 'grok')");

  const second = new Database(secondPath, { readonly: true });

  registerTestCleanup(() => {
    second.close();
  });

  expect(second.query("SELECT value FROM prefs WHERE key = 'last_used_agent'").all()).toStrictEqual(
    [],
  );
});

test('it throws when the run template is unset', () => {
  const ctx = setupTest();

  updateEnv('ATC_TEST_STATE_TEMPLATE', undefined);

  expect(() => {
    createMigratedStateDB(join(ctx.directory, 'state.db'));
  }).toThrowWithMessage(
    Error,
    'ATC_TEST_STATE_TEMPLATE is unset; run the tests through `bun run test`',
  );
});
