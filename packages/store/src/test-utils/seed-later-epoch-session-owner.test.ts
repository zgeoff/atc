import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMigratedStateDB, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createStateStore } from '../create-state-store';
import { buildMockFleetEntry } from '../testing/build-mock-fleet-entry';
import { seedLaterEpochSessionOwner } from './seed-later-epoch-session-owner';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-later-epoch-owner-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store };
}

test('it writes an owner row at the second ownership epoch', async () => {
  const ctx = await setupTest();

  seedLaterEpochSessionOwner(ctx, { session_id: 's-1', daemon_id: 'd-1' });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(db.query("SELECT * FROM session_owner WHERE session_id = 's-1'").get()).toMatchObject({
    daemon_id: 'd-1',
    owner_epoch: 2,
  });
});

test('it replaces the owner row a fleet write left for the same session', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('s-1') })]);

  seedLaterEpochSessionOwner(ctx, { session_id: 's-1', daemon_id: ctx.store.daemonID });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(db.query("SELECT * FROM session_owner WHERE session_id = 's-1'").all()).toMatchObject([
    { daemon_id: ctx.store.daemonID, owner_epoch: 2 },
  ]);
});
