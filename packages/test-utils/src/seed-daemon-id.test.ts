import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMigratedStateDB } from './create-migrated-state-db';
import { registerTestCleanup } from './register-test-cleanup';
import { seedDaemonID } from './seed-daemon-id';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-daemon-id-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  return { dbPath };
}

test('it writes the daemon id it is passed', () => {
  const ctx = setupTest();

  seedDaemonID(ctx, { daemonID: 'd-bakery' });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(db.query("SELECT value FROM prefs WHERE key = 'daemon_id'").all()).toStrictEqual([
    { value: 'd-bakery' },
  ]);
});

test('it draws a random daemon id when it is passed none, and returns it', () => {
  const ctx = setupTest();
  const daemonID = seedDaemonID(ctx);

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(db.query("SELECT value FROM prefs WHERE key = 'daemon_id'").all()).toStrictEqual([
    { value: daemonID },
  ]);
});
