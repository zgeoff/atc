import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { StateStore } from '../store/state-store';
import { createMigratedStateDB } from './create-migrated-state-db';
import { setupTempDir } from './setup-temp-dir';
import { updateEnv } from './update-env';

function setupTest() {
  return setupTempDir('atc-migrated-state-');
}

test('it creates a database the store opens without running a migration', async () => {
  await using ctx = setupTest();

  const dbPath = join(ctx.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const before = new Database(dbPath);

  onTestFinished(() => {
    before.close();
  });

  const ledgerBefore = before.query('SELECT name, timestamp FROM kysely_migration').all();

  before.close();

  const store = await StateStore.open(dbPath);

  onTestFinished(() => store.stop());

  await store.stop();

  const after = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    after.close();
  });

  expect(after.query('SELECT name, timestamp FROM kysely_migration').all()).toStrictEqual(
    ledgerBefore,
  );
});

test('it creates a database whose migration ledger holds every migration', async () => {
  await using ctx = setupTest();

  const freshPath = join(ctx.dir, 'fresh.db');
  const copyPath = join(ctx.dir, 'copy.db');

  const fresh = await StateStore.open(freshPath);

  onTestFinished(() => fresh.stop());

  await fresh.stop();

  await createMigratedStateDB(copyPath);

  const freshDB = new Database(freshPath, { readonly: true });

  onTestFinished(() => {
    freshDB.close();
  });

  const copyDB = new Database(copyPath, { readonly: true });

  onTestFinished(() => {
    copyDB.close();
  });

  expect(copyDB.query('SELECT name FROM kysely_migration ORDER BY name').all()).toStrictEqual(
    freshDB.query('SELECT name FROM kysely_migration ORDER BY name').all(),
  );
});

test('it creates a separate file for each call', async () => {
  await using ctx = setupTest();

  const firstPath = join(ctx.dir, 'first.db');
  const secondPath = join(ctx.dir, 'second.db');

  await createMigratedStateDB(firstPath);
  await createMigratedStateDB(secondPath);

  const first = new Database(firstPath);

  onTestFinished(() => {
    first.close();
  });

  first.run("INSERT INTO prefs (key, value) VALUES ('last_used_agent', 'grok')");

  const second = new Database(secondPath, { readonly: true });

  onTestFinished(() => {
    second.close();
  });

  expect(second.query("SELECT value FROM prefs WHERE key = 'last_used_agent'").all()).toStrictEqual(
    [],
  );
});

test('it rejects when the test home is unset', () => {
  using ctx = setupTest();

  updateEnv('ATC_TEST_HOME', undefined);

  expect(createMigratedStateDB(join(ctx.dir, 'state.db'))).rejects.toThrow(
    'ATC_TEST_HOME is unset; run the tests through `bun run test`',
  );
});
