import { expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubClock,
  getRecord,
  getString,
  registerTestCleanup,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { buildStubWebhookReceiver } from '../testing/build-stub-webhook-receiver';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { createTransportCaller } from '../tools/create-transport-caller';
import { createEventDeliverer } from './create-event-deliverer';

// A daemon whose every hook line becomes a finished turn, a caller that
// reaches it, and the authorization database the subscriptions live in.
async function setupTest(
  config: { readonly principals?: ReadonlyMap<string, readonly string[]> } = {},
) {
  const daemon = await startTestDaemon({
    prefix: 'atc-event-deliverer-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'turn-done' }] }),
      }),
      principals: config.principals ?? null,
    }),
  });

  const caller = createTransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const store = await openMCPAuth({
    dbPath: join(daemon.directory, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return {
    daemon,
    caller,
    db: store.db,
    clock: buildStubClock(Date.parse('2026-10-23T12:00:00.000Z')),
    directory: daemon.directory,
  };
}

test('it posts a signed delivery of a matching event with its session and the cursor past it', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();
  const secret = Buffer.alloc(32, 4);

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${secret.toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(1);
  });

  const [delivery] = receiver.received;

  invariant(delivery, 'the endpoint received no delivery');

  const webhookID = delivery.headers['webhook-id'] ?? '';
  const timestamp = String(Math.floor(ctx.clock.now() / 1000));

  const signature = createHmac('sha256', secret)
    .update(`${webhookID}.${timestamp}.${delivery.body}`)
    .digest('base64');

  expect(delivery.headers).toStrictEqual({
    'webhook-id': expect.stringMatching(/^msg_[\w-]+$/u),
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
    'x-mcp-subscription-id': 'sub_0123456789abcdef0123456789abcdef',
  });

  expect(JSON.parse(delivery.body)).toStrictEqual({
    eventId: expect.stringMatching(/^evt_[0-9a-f]{32}$/u),
    name: 'session.turn_done',
    timestamp: expect.toSatisfy((value: string) => !Number.isNaN(Date.parse(value))),
    data: { session: sessionID },
    cursor: expect.toBeString(),
  });
});

test('it delivers a cursor from which a read of the trail returns only later events', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(1);
  });

  const delivered: unknown = JSON.parse(receiver.received[0]?.body ?? '{}');

  invariant(
    typeof delivered === 'object' && delivered !== null && 'cursor' in delivered,
    'the delivery holds no cursor',
  );

  const after = await ctx.daemon.client.sendRequest('events.read', {
    cursor: String(delivered.cursor),
  });

  expect(after['events']).toStrictEqual([]);
});

test('it delivers nothing for an event of another type and moves its position past it', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.needs_input',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(async () => {
    const row = await ctx.db
      .selectFrom('atc_event_subscription')
      .select('position')
      .executeTakeFirstOrThrow();

    expect(row.position).not.toBe(getString(head, 'cursor'));
  });

  expect(receiver.received).toBeEmpty();
});

test('it resumes from the stored position, so an event that came while no server ran is delivered', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('events.read', {
      cursor: getString(head, 'cursor'),
    });

    expect(read['events']).toPartiallyContain({ kind: 'turn-done' });
  });

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  await waitFor(() => {
    expect(receiver.received).toHaveLength(1);
  });

  expect(JSON.parse(receiver.received[0]?.body ?? '{}')).toMatchObject({
    data: { session: sessionID },
  });
});

test("it delivers nothing from a session outside the client's reach", async () => {
  const ctx = await setupTest({
    principals: new Map([
      ['client-blind', []],
      ['client-local', ['local']],
    ]),
  });

  const receiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values([
      {
        id: 'sub_00000000000000000000000000000001',
        client_id: 'client-blind',
        url: 'https://hooks.example.com/hook',
        name: 'session.turn_done',
        arguments: '{}',
        secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
        position: getString(head, 'cursor'),
        refresh_before: '2026-10-24T12:00:00.000Z',
        created_at: '2026-10-23T12:00:00.000Z',
      },
      {
        id: 'sub_00000000000000000000000000000002',
        client_id: 'client-local',
        url: 'https://hooks.example.com/hook',
        name: 'session.turn_done',
        arguments: '{}',
        secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
        position: getString(head, 'cursor'),
        refresh_before: '2026-10-24T12:00:00.000Z',
        created_at: '2026-10-23T12:00:00.000Z',
      },
    ])
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  // Both watchers wait on the same trail, so once the client that reaches the
  // session has its delivery, the other has had the event to see.
  await waitFor(() => {
    expect(receiver.received).toHaveLength(1);
  });

  expect(
    receiver.received.map((request) => request.headers['x-mcp-subscription-id']),
  ).toStrictEqual(['sub_00000000000000000000000000000002']);
});

test('it removes a subscription whose client no longer holds read and delivers nothing to it', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();
  const probeAccess = mock<(clientID: string) => Promise<boolean>>(() => Promise.resolve(false));

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess,
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  await waitFor(async () => {
    const stored = await ctx.db.selectFrom('atc_event_subscription').selectAll().execute();

    expect(stored).toBeEmpty();
  });

  expect(probeAccess).toHaveBeenCalledWith('client-one');
  expect(receiver.received).toBeEmpty();
});

test('it removes a subscription past its refreshBefore and delivers nothing to it', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-23T11:59:59.000Z',
      created_at: '2026-10-22T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  await waitFor(async () => {
    const stored = await ctx.db.selectFrom('atc_event_subscription').selectAll().execute();

    expect(stored).toBeEmpty();
  });

  expect(receiver.received).toBeEmpty();
});

test('it logs a delivery the endpoint refused', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 500 }] });
  const log = mock<(line: string) => void>();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log,
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'atc events: delivery of session.turn_done to sub_0123456789abcdef0123456789abcdef failed: HTTP 500',
    );
  });
});

test('it retries a refused delivery after a backoff with the same webhook-id and a fresh signature', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 503 }] });

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([30_000]);
  });

  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(receiver.received).toHaveLength(2);
  });

  const [first, second] = receiver.received;

  invariant(first && second, 'the endpoint received fewer than two attempts');

  expect(second.headers['webhook-id']).toBe(first.headers['webhook-id']);
  expect(second.body).toBe(first.body);

  expect(Number(second.headers['webhook-timestamp'])).toBe(
    Number(first.headers['webhook-timestamp']) + 30,
  );

  expect(second.headers['webhook-signature']).not.toBe(first.headers['webhook-signature']);
});

test('it gives up on an event after its last attempt and delivers the next one', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({
    answers: [{ status: 500 }, { status: 500 }, { failure: 'timeout' }, { status: 500 }],
  });

  const log = mock<(line: string) => void>();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log,
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([30_000]);
  });

  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([120_000]);
  });

  ctx.clock.advance(120_000);

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([480_000]);
  });

  ctx.clock.advance(480_000);

  await waitFor(() => {
    expect(log).toHaveBeenCalledWith(
      'atc events: gave up on delivering session.turn_done to sub_0123456789abcdef0123456789abcdef',
    );
  });

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(5);
  });

  const bodies = receiver.received.map((request) => request.body);

  expect(new Set(bodies.slice(0, 4)).size).toBe(1);
  expect(bodies[4]).not.toBe(bodies[0]);
});

test('it moves past an event its endpoint refuses as too large without a retry', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 413 }] });

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });
  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(() => {
    expect(receiver.received).toHaveLength(2);
  });

  const bodies = receiver.received.map((request) => request.body);

  expect(bodies[1]).not.toBe(bodies[0]);
  expect(ctx.clock.collectPending()).toStrictEqual([]);
});

test('it removes a subscription whose endpoint answers 410 and delivers nothing more to it', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 410 }] });

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });
  await ctx.daemon.sendHookLines({ atcId: sessionID, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const rows = await ctx.db.selectFrom('atc_event_subscription').select('id').execute();

    expect(rows).toStrictEqual([]);
  });

  expect(receiver.received).toHaveLength(1);
  expect(ctx.clock.collectPending()).toStrictEqual([]);
});

test('it delivers an event again after a restart when a stop cut its retries short', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 503 }] });
  const restartedReceiver = buildStubWebhookReceiver();

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([30_000]);
  });

  deliverer.stop();

  const restarted = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: restartedReceiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(restarted.stop);

  await restarted.start();

  await waitFor(() => {
    expect(restartedReceiver.received).toHaveLength(1);
  });

  const [cut] = receiver.received;
  const [redelivered] = restartedReceiver.received;

  invariant(cut && redelivered, 'an endpoint received no delivery');

  expect(redelivered.body).toBe(cut.body);
});

test('it ends a retired watcher and starts afresh on the next watch', async () => {
  const ctx = await setupTest();

  const receiver = buildStubWebhookReceiver({ answers: [{ status: 503 }] });

  const head = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  await ctx.db
    .insertInto('atc_event_subscription')
    .values({
      id: 'sub_0123456789abcdef0123456789abcdef',
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      position: getString(head, 'cursor'),
      refresh_before: '2026-10-24T12:00:00.000Z',
      created_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const deliverer = createEventDeliverer({
    db: ctx.db,
    caller: ctx.caller,
    send: receiver.send,
    clock: ctx.clock,
    probeAccess: () => Promise.resolve(true),
    log: () => {},
  });

  registerTestCleanup(deliverer.stop);

  await deliverer.start();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.sendHookLines({
    atcId: getString(getRecord(spawned, 'session'), 'id'),
    event: 'Stop',
    payload: {},
  });

  await waitFor(() => {
    expect(ctx.clock.collectPending()).toStrictEqual([30_000]);
  });

  deliverer.retire('sub_0123456789abcdef0123456789abcdef');

  const pendingAfterRetire = ctx.clock.collectPending();

  deliverer.watch('sub_0123456789abcdef0123456789abcdef');

  await waitFor(() => {
    expect(receiver.received).toHaveLength(2);
  });

  expect(pendingAfterRetire).toStrictEqual([]);
});
