import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildStubClock,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createStateStore } from '../create-state-store';
import { seedMaterialization } from './seed-materialization';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-materialization-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store, clock: buildStubClock(1000) };
}

test('it writes a materialization row in the resolving phase at the clock time', async () => {
  const ctx = await setupTest();

  await seedMaterialization(ctx, { sessionID: toSessionID('s-1') });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({ phase: 'resolving', target: 'local', started_at: 1000, updated_at: 1000 });
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  await seedMaterialization(ctx, {
    sessionID: toSessionID('s-1'),
    target: 'box',
    directory: '/work/bakery',
    sourceKind: 'path',
    withheldEnv: ['GIT_ASKPASS'],
  });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({
    target: 'box',
    directory: '/work/bakery',
    source_kind: 'path',
    withheld_env: '["GIT_ASKPASS"]',
  });
});
