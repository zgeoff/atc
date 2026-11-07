import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { createMigratedStateDB } from './create-migrated-state-db';
import { seedDaemonID } from './seed-daemon-id';

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
