import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { removeCompletedIdempotencyKeys } from './remove-completed-idempotency-keys';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remove-completed-keys-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  return { dbPath, store };
}

test('it drops a key completed moments ago and keeps one whose outcome is unknown', async () => {
  const ctx = await setupTest();

  const completed = { principal: 'owner', operation: 'session.spawn', key: 'k-done' };
  const unknown = { principal: 'owner', operation: 'session.spawn', key: 'k-unknown' };

  await ctx.store.claimIdempotencyKey({ ...completed, payloadHash: 'h', effectRef: 's-1', at: 1 });
  await ctx.store.updateIdempotencyCompleted(completed, '{"session":"s-1"}', Date.now(), null);
  await ctx.store.claimIdempotencyKey({ ...unknown, payloadHash: 'h', effectRef: 's-2', at: 1 });
  await ctx.store.updateIdempotencyOutcomeUnknown(unknown, Date.now());

  await removeCompletedIdempotencyKeys(ctx.dbPath);

  const keys = await ctx.store.readIdempotencyKeys();

  expect(keys.map((record) => record.key)).toStrictEqual(['k-unknown']);
});
