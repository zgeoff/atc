import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createStateStore } from '../create-state-store';
import { createMigratedStateDB } from './create-migrated-state-db';
import { seedTransferringMaterialization } from './seed-transferring-materialization';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-transferring-materialization-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store, clock: buildStubClock(2000) };
}

test('it writes a materialization row in the transferring phase', async () => {
  const ctx = await setupTest();

  await seedTransferringMaterialization(ctx, { sessionID: toSessionID('s-1') });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({ phase: 'transferring', updated_at: 2000 });
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  await seedTransferringMaterialization(ctx, {
    sessionID: toSessionID('s-1'),
    target: 'box',
    directory: '/work/bakery',
  });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({ target: 'box', directory: '/work/bakery' });
});
