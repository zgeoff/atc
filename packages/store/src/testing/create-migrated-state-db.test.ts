import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir, updateEnv } from '@atc/test-utils';
import { StateStore } from '../state-store';
import { createMigratedStateDB } from './create-migrated-state-db';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-migrated-state-');

  return { directory: temporaryDirectory.path };
}

test('it creates a database the store opens without running a migration', async () => {
  const ctx = setupTest();
  const dbPath = join(ctx.directory, 'state.db');

  await createMigratedStateDB(dbPath);

  const before = new Database(dbPath);

  const closeBefore = registerTestCleanup(() => {
    before.close();
  });

  const ledgerBefore = before.query('SELECT name, timestamp FROM kysely_migration').all();

  closeBefore();

  const store = await StateStore.open(dbPath);

  const stopStore = registerTestCleanup(() => store.stop());

  await stopStore();

  const after = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    after.close();
  });

  expect(after.query('SELECT name, timestamp FROM kysely_migration').all()).toStrictEqual(
    ledgerBefore,
  );
});

test('it creates a database whose migration ledger holds every migration', async () => {
  const ctx = setupTest();
  const freshPath = join(ctx.directory, 'fresh.db');
  const copyPath = join(ctx.directory, 'copy.db');

  const fresh = await StateStore.open(freshPath);

  const stopFresh = registerTestCleanup(() => fresh.stop());

  await stopFresh();
  await createMigratedStateDB(copyPath);

  const freshDB = new Database(freshPath, { readonly: true });

  registerTestCleanup(() => {
    freshDB.close();
  });

  const copyDB = new Database(copyPath, { readonly: true });

  registerTestCleanup(() => {
    copyDB.close();
  });

  expect(copyDB.query('SELECT name FROM kysely_migration ORDER BY name').all()).toStrictEqual(
    freshDB.query('SELECT name FROM kysely_migration ORDER BY name').all(),
  );
});

test('it creates a separate file for each call', async () => {
  const ctx = setupTest();
  const firstPath = join(ctx.directory, 'first.db');
  const secondPath = join(ctx.directory, 'second.db');

  await createMigratedStateDB(firstPath);
  await createMigratedStateDB(secondPath);

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

test('it rejects when the test home is unset', () => {
  const ctx = setupTest();

  updateEnv('ATC_TEST_HOME', undefined);

  expect(createMigratedStateDB(join(ctx.directory, 'state.db'))).rejects.toThrowWithMessage(
    Error,
    'ATC_TEST_HOME is unset; run the tests through `bun run test`',
  );
});
