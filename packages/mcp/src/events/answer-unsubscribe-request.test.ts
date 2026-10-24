import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { answerUnsubscribeRequest } from './answer-unsubscribe-request';
import { buildSubscriptionID } from './build-subscription-id';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-answer-unsubscribe-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const deliverer = {
    start: () => Promise.resolve(),
    watch: () => {},
    retire: mock<(subscriptionID: string) => void>(),
    stop: () => {},
  };

  return { db: store.db, deliverer };
}

test('it ends the subscription its key names and answers the same when repeated', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: buildSubscriptionID({
        clientID: 'client-one',
        url: 'https://hooks.example.com/hook',
        name: 'session.turn_done',
        arguments: '{}',
      }),
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-1',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const params = {
    name: 'session.turn_done',
    arguments: {},
    delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook' },
  };

  const first = await answerUnsubscribeRequest(
    { db: ctx.db, clientID: 'client-one', deliverer: ctx.deliverer },
    params,
  );

  const second = await answerUnsubscribeRequest(
    { db: ctx.db, clientID: 'client-one', deliverer: ctx.deliverer },
    params,
  );

  const rows = await ctx.db.selectFrom('atc_event_subscription').select('id').execute();

  expect(first).toStrictEqual({});
  expect(second).toStrictEqual({});
  expect(rows).toStrictEqual([]);
});

test("it retires the subscription's watcher, so its work never reaches a later subscription with the same key", async () => {
  const ctx = await setupTest();

  await answerUnsubscribeRequest(
    { db: ctx.db, clientID: 'client-one', deliverer: ctx.deliverer },
    {
      name: 'session.turn_done',
      delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook' },
    },
  );

  expect(ctx.deliverer.retire).toHaveBeenCalledExactlyOnceWith(
    buildSubscriptionID({
      clientID: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
    }),
  );
});

test("it never ends another client's subscription to the same callback", async () => {
  const ctx = await setupTest();

  const id = buildSubscriptionID({
    clientID: 'client-two',
    url: 'https://hooks.example.com/hook',
    name: 'session.turn_done',
    arguments: '{}',
  });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id,
      client_id: 'client-two',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-1',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  await answerUnsubscribeRequest(
    { db: ctx.db, clientID: 'client-one', deliverer: ctx.deliverer },
    {
      name: 'session.turn_done',
      delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook' },
    },
  );

  const rows = await ctx.db.selectFrom('atc_event_subscription').select('id').execute();

  expect(rows).toStrictEqual([{ id }]);
});

test('it ends no subscription for a key with arguments, which no subscription holds', async () => {
  const ctx = await setupTest();

  const id = buildSubscriptionID({
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    name: 'session.turn_done',
    arguments: '{}',
  });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id,
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-1',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const answer = await answerUnsubscribeRequest(
    { db: ctx.db, clientID: 'client-one', deliverer: ctx.deliverer },
    {
      name: 'session.turn_done',
      arguments: { session: 'session-7' },
      delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook' },
    },
  );

  const rows = await ctx.db.selectFrom('atc_event_subscription').select('id').execute();

  expect(answer).toStrictEqual({});
  expect(rows).toStrictEqual([{ id }]);
});
