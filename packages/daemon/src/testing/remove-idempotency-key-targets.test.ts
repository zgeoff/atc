import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/test-utils';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { removeIdempotencyKeyTargets } from './remove-idempotency-key-targets';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remove-key-targets-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store };
}

test('it drops the target of a completed key and keeps its result', async () => {
  const ctx = await setupTest();

  const id = { principal: 'ci', operation: 'session.spawn', key: 'k-1' };

  await ctx.store.claimIdempotencyKey({ ...id, payloadHash: 'h', effectRef: 's-1', at: 1 });

  await ctx.store.updateIdempotencyCompleted(id, '{"session":"s-1"}', 2, {
    target: 'box',
    targetIdentity: 'local-pty:box',
  });

  await removeIdempotencyKeyTargets(ctx.dbPath);

  expect(ctx.store.readIdempotencyKey(id)).resolves.toStrictEqual({
    ...id,
    payloadHash: 'h',
    state: 'completed',
    effectRef: 's-1',
    result: '{"session":"s-1"}',
    effectTarget: null,
    createdAt: 1,
    updatedAt: 2,
  });
});

test('it leaves a key in progress as it was', async () => {
  const ctx = await setupTest();

  const id = { principal: 'ci', operation: 'session.spawn', key: 'k-1' };

  await ctx.store.claimIdempotencyKey({ ...id, payloadHash: 'h', effectRef: 's-1', at: 1 });

  await removeIdempotencyKeyTargets(ctx.dbPath);

  expect(ctx.store.readIdempotencyKey(id)).resolves.toStrictEqual({
    ...id,
    payloadHash: 'h',
    state: 'in_progress',
    effectRef: 's-1',
    result: null,
    effectTarget: null,
    createdAt: 1,
    updatedAt: 1,
  });
});
