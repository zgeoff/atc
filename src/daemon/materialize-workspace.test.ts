import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { materializeWorkspace } from './materialize-workspace';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-materialize-'));
  const scratch = join(tmp.dir, 'scratch');
  const dbPath = join(tmp.dir, 'state.db');

  // The staging root must exist for a clone to stage in it.
  mkdirSync(scratch);

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  stack.defer(() => store.stop());

  const owned = stack.move();

  return { scratch, store, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it leaves no staging directory behind when the materialization row cannot be written', async () => {
  await using ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(ctx.scratch, 'other'),
      sourceKind: 'git',
      withheldEnv: [],
    },
    Date.now(),
  );

  const materialized = materializeWorkspace(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(ctx.scratch, 'ws'),
      source: { kind: 'git', url: 'https://example.com/repo.git', ref: 'main' },
      inPlace: false,
    },
    {
      requireProvider: () => {
        throw new Error('no provider call is expected');
      },
      store: ctx.store,
      log: () => {},
      readyHost: () => Promise.reject(new Error('no host is expected')),
      removeClaim: () => Promise.resolve(true),
      stagingRoot: ctx.scratch,
      gitTransports: ['https', 'ssh'],
    },
  );

  expect(materialized).rejects.toThrow(
    'UNIQUE constraint failed: workspace_materialization.session_id',
  );

  expect(readdirSync(ctx.scratch)).toStrictEqual([]);
});
