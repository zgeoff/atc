import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createStateStore } from '../create-state-store';
import { createMigratedStateDB } from './create-migrated-state-db';
import { seedFailedMaterialization } from './seed-failed-materialization';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-failed-materialization-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store, clock: buildStubClock(2000) };
}

test('it writes a materialization row in the failed phase with its refusal', async () => {
  const ctx = await setupTest();

  await seedFailedMaterialization(ctx, { sessionID: toSessionID('s-1') });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({ phase: 'failed', error_code: 'sanitize_failed', updated_at: 2000 });
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  await seedFailedMaterialization(ctx, {
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
