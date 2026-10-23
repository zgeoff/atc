import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createSubscriptionStore } from './create-subscription-store';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-subscription-store-');

  const auth = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => auth.close());

  return { db: auth.db, store: createSubscriptionStore(auth.db) };
}

test('it stores a new subscription as live', async () => {
  const ctx = await setupTest();

  const started = await ctx.store.start(
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

  const stored = await ctx.store.read('sub_one', Date.parse('2026-10-23T12:00:00.000Z'));

  expect(started).toBeTrue();

  expect(stored).toStrictEqual({
    row: {
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
    state: 'live',
  });
});

test('it reads a subscription at its refresh time as expired', async () => {
  const ctx = await setupTest();

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

  const stored = await ctx.store.read('sub_one', Date.parse('2026-10-24T12:00:00.000Z'));

  expect(stored?.state).toBe('expired');
});

test('it refuses to start over a live subscription', async () => {
  const ctx = await setupTest();

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

  const started = await ctx.store.start(
    {
      id: 'sub_one',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: 'secret-two',
      position: 'cursor-two',
      refresh_before: '2026-10-25T12:00:00.000Z',
      created_at: '2026-10-23T13:00:00.000Z',
    },
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  const stored = await ctx.db.selectFrom('atc_event_subscription').select('secret').execute();

  expect(started).toBeFalse();
  expect(stored).toStrictEqual([{ secret: 'secret-one' }]);
});

test('it starts over an expired subscription', async () => {
  const ctx = await setupTest();

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

  const started = await ctx.store.start(
    {
      id: 'sub_one',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: 'secret-two',
      position: 'cursor-two',
      refresh_before: '2026-10-26T12:00:00.000Z',
      created_at: '2026-10-25T12:00:00.000Z',
    },
    Date.parse('2026-10-25T12:00:00.000Z'),
  );

  const stored = await ctx.db
    .selectFrom('atc_event_subscription')
    .select(['secret', 'position', 'refresh_before', 'created_at'])
    .execute();

  expect(started).toBeTrue();

  expect(stored).toStrictEqual([
    {
      secret: 'secret-two',
      position: 'cursor-two',
      refresh_before: '2026-10-26T12:00:00.000Z',
      created_at: '2026-10-25T12:00:00.000Z',
    },
  ]);
});

test('it refreshes a live subscription', async () => {
  const ctx = await setupTest();

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

  const refreshed = await ctx.store.refresh(
    'sub_one',
    { secret: 'secret-two', refresh_before: '2026-10-25T13:00:00.000Z' },
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  const stored = await ctx.db
    .selectFrom('atc_event_subscription')
    .select(['secret', 'refresh_before'])
    .execute();

  expect(refreshed).toBeTrue();

  expect(stored).toStrictEqual([
    { secret: 'secret-two', refresh_before: '2026-10-25T13:00:00.000Z' },
  ]);
});

test('it refuses to refresh an expired subscription', async () => {
  const ctx = await setupTest();

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

  const refreshed = await ctx.store.refresh(
    'sub_one',
    { secret: 'secret-two', refresh_before: '2026-10-26T12:00:00.000Z' },
    Date.parse('2026-10-25T12:00:00.000Z'),
  );

  const stored = await ctx.db
    .selectFrom('atc_event_subscription')
    .select(['secret', 'refresh_before'])
    .execute();

  expect(refreshed).toBeFalse();

  expect(stored).toStrictEqual([
    { secret: 'secret-one', refresh_before: '2026-10-24T12:00:00.000Z' },
  ]);
});

test('it advances a live subscription', async () => {
  const ctx = await setupTest();

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

  const advanced = await ctx.store.advance(
    'sub_one',
    'cursor-two',
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  const stored = await ctx.db.selectFrom('atc_event_subscription').select('position').execute();

  expect(advanced).toBeTrue();
  expect(stored).toStrictEqual([{ position: 'cursor-two' }]);
});

test('it refuses to advance an expired subscription', async () => {
  const ctx = await setupTest();

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

  const advanced = await ctx.store.advance(
    'sub_one',
    'cursor-two',
    Date.parse('2026-10-24T12:00:00.000Z'),
  );

  const stored = await ctx.db.selectFrom('atc_event_subscription').select('position').execute();

  expect(advanced).toBeFalse();
  expect(stored).toStrictEqual([{ position: 'cursor-one' }]);
});

test('it removes an expired subscription', async () => {
  const ctx = await setupTest();

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

  const removed = await ctx.store.expire(
    'sub_one',
    '2026-10-24T12:00:00.000Z',
    Date.parse('2026-10-24T12:00:00.000Z'),
  );

  const remaining = await ctx.store.readIDs();

  expect(removed).toBeTrue();
  expect(remaining).toStrictEqual([]);
});

test('it refuses to expire a live subscription', async () => {
  const ctx = await setupTest();

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

  const removed = await ctx.store.expire(
    'sub_one',
    '2026-10-24T12:00:00.000Z',
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  const remaining = await ctx.store.readIDs();

  expect(removed).toBeFalse();
  expect(remaining).toStrictEqual(['sub_one']);
});

test('it keeps a subscription that a refresh renewed after the expiry was read', async () => {
  const ctx = await setupTest();

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

  await ctx.store.refresh(
    'sub_one',
    { secret: 'secret-one', refresh_before: '2026-10-25T12:00:00.000Z' },
    Date.parse('2026-10-23T13:00:00.000Z'),
  );

  const removed = await ctx.store.expire(
    'sub_one',
    '2026-10-24T12:00:00.000Z',
    Date.parse('2026-10-25T12:00:00.000Z'),
  );

  const remaining = await ctx.store.readIDs();

  expect(removed).toBeFalse();
  expect(remaining).toStrictEqual(['sub_one']);
});

test('it ends only the subscriptions of the client it names', async () => {
  const ctx = await setupTest();

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

  await ctx.store.start(
    {
      id: 'sub_two',
      client_id: 'client-two',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: 'secret-two',
      position: 'cursor-one',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    },
    Date.parse('2026-10-23T12:00:00.000Z'),
  );

  await ctx.store.endForClient('client-one');

  const remaining = await ctx.store.readIDs();

  expect(remaining).toStrictEqual(['sub_two']);
});
