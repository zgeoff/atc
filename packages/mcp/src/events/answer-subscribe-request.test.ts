import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { buildStubFleetCaller } from '../testing/build-stub-fleet-caller';
import { buildStubWebhookReceiver } from '../testing/build-stub-webhook-receiver';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { answerSubscribeRequest } from './answer-subscribe-request';

// The authorization database the subscriptions live in, a clock at a fixed
// instant, and a deliverer that records which subscriptions it was told to watch.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-answer-subscribe-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const deliverer = {
    start: () => Promise.resolve(),
    watch: mock(),
    retire: mock<(subscriptionID: string) => void>(),
    stop: () => {},
  };

  return { db: store.db, clock: buildStubClock(Date.parse('2026-10-23T12:00:00.000Z')), deliverer };
}

test('it grants a new subscription from the newest event for a day', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const result = await answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller({
        answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
      }),
      clientID: 'client-one',
      send: receiver.send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.needs_input',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
      cursor: null,
    },
  );

  expect(result).toStrictEqual({
    id: expect.stringMatching(/^sub_[0-9a-f]{32}$/u),
    refreshBefore: '2026-10-24T12:00:00.000Z',
    cursor: 'cursor-head',
    truncated: false,
  });
});

test('it tells the deliverer to watch the subscription it stored', async () => {
  const ctx = await setupTest();

  const result = await answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller({
        answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
      }),
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.needs_input',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    },
  );

  const stored = await ctx.db.selectFrom('atc_event_subscription').selectAll().execute();

  expect(ctx.deliverer.watch).toHaveBeenCalledExactlyOnceWith(result.id);

  expect(stored).toStrictEqual([
    {
      id: result.id,
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      position: 'cursor-head',
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    },
  ]);
});

test('it starts a subscription without a cursor past every event a gateway holds back for a later page', async () => {
  const ctx = await setupTest();

  const caller = buildStubFleetCaller({
    answer: (request) =>
      ({
        null: { events: [{ cursor: 'cursor-a' }], cursor: 'cursor-partial', more: true },
        '"cursor-partial"': {
          events: [{ cursor: 'cursor-b' }],
          cursor: 'cursor-past-all',
          more: false,
        },
      })[JSON.stringify(request.params?.['cursor'] ?? null)] ?? {},
  });

  const result = await answerSubscribeRequest(
    {
      db: ctx.db,
      caller,
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    },
  );

  expect(result.cursor).toBe('cursor-past-all');
});

test("it starts a new subscription at the client's cursor once the daemon takes it", async () => {
  const ctx = await setupTest();

  const caller = buildStubFleetCaller({
    answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
  });

  const result = await answerSubscribeRequest(
    {
      db: ctx.db,
      caller,
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
      cursor: 'cursor-7',
    },
  );

  expect(result.cursor).toBe('cursor-7');

  expect(caller.requests).toStrictEqual([
    { method: 'events.read', params: { cursor: 'cursor-7', limit: 1 } },
  ]);
});

test('it refreshes a subscription with its new secret and keeps the position its deliveries reached', async () => {
  const ctx = await setupTest();

  const deps = {
    db: ctx.db,
    caller: buildStubFleetCaller({
      answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
    }),
    clientID: 'client-one',
    send: buildStubWebhookReceiver().send,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  };

  const first = await answerSubscribeRequest(deps, {
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  await ctx.db
    .updateTable('atc_event_subscription')
    .set({ position: 'cursor-9' })
    .where('id', '=', first.id)
    .execute();

  ctx.clock.advance(60 * 60 * 1000);
  ctx.deliverer.retire.mockClear();

  const refreshed = await answerSubscribeRequest(deps, {
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 6).toString('base64')}`,
    },
    cursor: 'cursor-1',
  });

  const stored = await ctx.db
    .selectFrom('atc_event_subscription')
    .select(['secret', 'position'])
    .execute();

  expect(refreshed).toStrictEqual({
    id: first.id,
    refreshBefore: '2026-10-24T13:00:00.000Z',
    cursor: 'cursor-9',
    truncated: false,
  });

  expect(stored).toStrictEqual([
    { secret: `whsec_${Buffer.alloc(32, 6).toString('base64')}`, position: 'cursor-9' },
  ]);

  expect(ctx.deliverer.retire).not.toHaveBeenCalled();
});

test("it restarts a subscription past its refreshBefore from the client's cursor", async () => {
  const ctx = await setupTest();

  const deps = {
    db: ctx.db,
    caller: buildStubFleetCaller({
      answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
    }),
    clientID: 'client-one',
    send: buildStubWebhookReceiver().send,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  };

  const first = await answerSubscribeRequest(deps, {
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  await ctx.db
    .updateTable('atc_event_subscription')
    .set({ position: 'cursor-9' })
    .where('id', '=', first.id)
    .execute();

  ctx.clock.advance(25 * 60 * 60 * 1000);
  ctx.deliverer.retire.mockClear();

  const renewed = await answerSubscribeRequest(deps, {
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
    cursor: 'cursor-3',
  });

  const stored = await ctx.db.selectFrom('atc_event_subscription').select('position').execute();

  expect(renewed.cursor).toBe('cursor-3');
  expect(ctx.deliverer.retire).toHaveBeenCalledExactlyOnceWith(first.id);
  expect(stored).toStrictEqual([{ position: 'cursor-3' }]);
});

test("it sends one verification challenge for a client's callback URL across event types", async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const deps = {
    db: ctx.db,
    caller: buildStubFleetCaller({
      answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
    }),
    clientID: 'client-one',
    send: receiver.send,
    clock: ctx.clock,
    deliverer: ctx.deliverer,
  };

  await answerSubscribeRequest(deps, {
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  await answerSubscribeRequest(deps, {
    name: 'session.needs_input',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  expect(receiver.received).toHaveLength(1);
});

test('it challenges the same callback URL again for another client', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const caller = buildStubFleetCaller({
    answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
  });

  await answerSubscribeRequest(
    {
      db: ctx.db,
      caller,
      clientID: 'client-one',
      send: receiver.send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    },
  );

  await answerSubscribeRequest(
    {
      db: ctx.db,
      caller,
      clientID: 'client-two',
      send: receiver.send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
      },
    },
  );

  expect(receiver.received).toHaveLength(2);
});

test('it refuses a callback that does not echo the challenge and stores no subscription', async () => {
  const ctx = await setupTest();

  const subscribed = answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller({
        answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
      }),
      clientID: 'client-one',
      send: buildStubWebhookReceiver({ echoes: false }).send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    },
  );

  expect(subscribed).rejects.toMatchObject({
    code: -32_015,
    data: { reason: 'challenge_failed' },
  });

  const stored = await ctx.db.selectFrom('atc_event_subscription').selectAll().execute();

  expect(stored).toBeEmpty();
});

test('it refuses a cursor the daemon refuses as invalid params', async () => {
  const ctx = await setupTest();

  const subscribed = answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller({
        answer: () => {
          throw new DaemonError('bad_args', 'cursor: not a cursor');
        },
      }),
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
      cursor: 'not-a-cursor',
    },
  );

  expect(subscribed).rejects.toMatchObject({
    code: -32_602,
    message: 'atc does not take that cursor',
  });
});

test('it refuses an unknown event type as not found', async () => {
  const ctx = await setupTest();

  const subscribed = answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller(),
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.exploded',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
    },
  );

  expect(subscribed).rejects.toMatchObject({ code: -32_023, data: { kind: 'event' } });
});

test.each([
  ['a short suggestion up to a minute', 1000, '2026-10-23T12:01:00.000Z'],
  ['an hour as asked', 3_600_000, '2026-10-23T13:00:00.000Z'],
  ['a long suggestion down to seven days', 30 * 86_400_000, '2026-10-30T12:00:00.000Z'],
  ['a request for no expiry as seven days', null, '2026-10-30T12:00:00.000Z'],
])('it grants %s', async (_label, ttlMs, refreshBefore) => {
  const ctx = await setupTest();

  const result = await answerSubscribeRequest(
    {
      db: ctx.db,
      caller: buildStubFleetCaller({
        answer: () => ({ events: [], cursor: 'cursor-head', more: false }),
      }),
      clientID: 'client-one',
      send: buildStubWebhookReceiver().send,
      clock: ctx.clock,
      deliverer: ctx.deliverer,
    },
    {
      name: 'session.turn_done',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.com/hook',
        secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
      },
      ttlMs,
    },
  );

  expect(result.refreshBefore).toBe(refreshBefore);
});
