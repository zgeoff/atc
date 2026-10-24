import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { createSubscriptionStore } from '../events/create-subscription-store';
import { buildStubRacingSubscriptionStore } from './build-stub-racing-subscription-store';
import { openTestAuthDatabase } from './open-test-auth-database';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-racing-store-');

  const auth = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => auth.close());

  return { store: createSubscriptionStore(auth.db) };
}

test('it runs the racing write after a read that finds an expired subscription', async () => {
  const ctx = await setupTest();

  const between = mock(() => Promise.resolve());

  await ctx.store.start(
    {
      id: 'sub_one',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: 'secret-one',
      position: 'cursor-one',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    },
    Date.parse('2026-10-23T12:00:00.000Z'),
  );

  const stored = await buildStubRacingSubscriptionStore(ctx.store, between).read(
    'sub_one',
    Date.parse('2026-10-24T12:00:00.000Z'),
  );

  expect(stored?.state).toBe('expired');
  expect(between).toHaveBeenCalledOnce();
});

test('it runs no racing write after a read that finds a live subscription', async () => {
  const ctx = await setupTest();

  const between = mock(() => Promise.resolve());

  await ctx.store.start(
    {
      id: 'sub_one',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: 'secret-one',
      position: 'cursor-one',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    },
    Date.parse('2026-10-23T12:00:00.000Z'),
  );

  const stored = await buildStubRacingSubscriptionStore(ctx.store, between).read(
    'sub_one',
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  expect(stored?.state).toBe('live');
  expect(between).not.toHaveBeenCalled();
});
