import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { createStateStore } from '../create-state-store';
import { createMigratedStateDB } from './create-migrated-state-db';
import { seedReadyMaterialization } from './seed-ready-materialization';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-ready-materialization-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store, clock: buildStubClock(2000) };
}

test('it writes a materialization row in the ready phase, materialized at the clock time', async () => {
  const ctx = await setupTest();

  await seedReadyMaterialization(ctx, { sessionID: toSessionID('s-1') });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  expect(
    db.query("SELECT * FROM workspace_materialization WHERE session_id = 's-1'").get(),
  ).toMatchObject({
    phase: 'ready',
    repo_url: 'https://example.com/acme/app.git',
    sha: '0123456789abcdef0123456789abcdef01234567',
    materialized_at: 2000,
  });
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  await seedReadyMaterialization(ctx, {
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
