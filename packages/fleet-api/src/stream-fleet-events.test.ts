import { expect, test } from 'bun:test';
import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { createRouterClient } from '@orpc/server';
import { waitFor } from '@zgeoff/testing';
import { createFakeClock } from '@zgeoff/testing/clock';
import { createFleetRouter } from './create-fleet-router';
import { buildMockEventsPage } from './test-utils/build-mock-events-page';
import { buildMockFleetEvent } from './test-utils/build-mock-fleet-event';
import { buildPagedFleetCaller } from './test-utils/build-paged-fleet-caller';
import { buildStubFleetCaller } from './test-utils/build-stub-fleet-caller';
import { toStreamItemSummary } from './test-utils/to-stream-item-summary';
import type { FleetCaller } from './types';

interface StreamInput {
  readonly cursor?: string;
}

interface StreamCall {
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
}

function setupTest() {
  const clock = createFakeClock();
  const principal = { id: 'service:ci-runner', name: 'ci-runner' };

  return {
    clock,
    principal,
    open: (
      caller: FleetCaller,
      input: StreamInput,
      call: StreamCall = {},
      scopes: readonly GrantScope[] = ['read'],
    ) => {
      const router = createFleetRouter({ caller, contract: FLEET_CONTRACT, clock });
      const client = createRouterClient(router, { context: { principal, scopes } });

      return client.events.stream(input, call);
    },
  };
}

test('it gives each event item the merged cursor of its event as its event id', async () => {
  const ctx = setupTest();
  const caller = buildPagedFleetCaller([buildMockEventsPage('g1.c', ['g1.a', 'g1.b'])]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });
  const first = await stream.next();
  const second = await stream.next();

  expect([toStreamItemSummary(first.value), toStreamItemSummary(second.value)]).toStrictEqual([
    ['event', 'g1.a', null],
    ['event', 'g1.b', null],
  ]);
});

test('it reads the trail as the caller principal, one page at a time', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller({ answer: () => buildMockEventsPage('g1.c', ['g1.a']) });

  const stream = await ctx.open(caller, { cursor: 'g1.0' });

  await stream.next();

  expect(caller.requests).toStrictEqual([
    {
      method: 'events.read',
      params: { cursor: 'g1.0', limit: 50, waitMs: 30_000 },
      principal: ctx.principal,
    },
  ]);
});

test('it reads the next page only after the client took the last item of the page', async () => {
  const ctx = setupTest();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', ['g1.a', 'g1.b']),
    buildMockEventsPage('g1.c', ['g1.c']),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });

  await stream.next();
  await stream.next();

  const readsBeforeLastTaken = caller.requests.length;

  await stream.next();

  expect([readsBeforeLastTaken, caller.requests.length]).toStrictEqual([1, 2]);
});

test('it starts after the last event id of a reconnect, over the input cursor', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller({ answer: () => buildMockEventsPage('g1.z', ['g1.z']) });

  const stream = await ctx.open(caller, { cursor: 'g1.input' }, { lastEventId: 'g1.last' });

  await stream.next();

  expect(caller.requests.map((request) => request.params?.['cursor'])).toStrictEqual(['g1.last']);
});

test('it starts after the input cursor when the request holds no last event id', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller({ answer: () => buildMockEventsPage('g1.z', ['g1.z']) });

  const stream = await ctx.open(caller, { cursor: 'g1.input' });

  await stream.next();

  expect(caller.requests.map((request) => request.params?.['cursor'])).toStrictEqual(['g1.input']);
});

test('it starts after the newest event of each daemon with no cursor and no last event id', async () => {
  const ctx = setupTest();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.head1', ['g1.old1'], { more: true }),
    buildMockEventsPage('g1.head2', ['g1.old2']),
    buildMockEventsPage('g1.next', ['g1.new']),
  ]);

  const stream = await ctx.open(caller, {});
  const first = await stream.next();

  expect([
    toStreamItemSummary(first.value),
    caller.requests.map((request) => request.params),
  ]).toStrictEqual([
    ['event', 'g1.new', null],
    [
      { limit: 200 },
      { cursor: 'g1.head1', limit: 200 },
      { cursor: 'g1.head2', limit: 50, waitMs: 30_000 },
    ],
  ]);
});

test('it yields a daemons item only when its lists change, after the events of its page', async () => {
  const ctx = setupTest();
  const down = { unavailable: ['laptop'] };

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', ['g1.a'], down),
    buildMockEventsPage('g1.c', ['g1.c'], down),
    buildMockEventsPage('g1.d', [], { started: ['laptop'] }),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });

  const items = [
    await stream.next(),
    await stream.next(),
    await stream.next(),
    await stream.next(),
  ];

  expect(items.map((item) => toStreamItemSummary(item.value))).toStrictEqual([
    ['event', 'g1.a', null],
    ['daemons', 'g1.b', [['laptop'], []]],
    ['event', 'g1.c', null],
    ['daemons', 'g1.d', [[], ['laptop']]],
  ]);
});

test('it waits out an outage on the clock before it reads an empty page again', async () => {
  const ctx = setupTest();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', [], { unavailable: ['laptop'] }),
    buildMockEventsPage('g1.c', ['g1.c'], { unavailable: ['laptop'] }),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });

  await stream.next();

  const next = stream.next();

  await waitFor(() => ctx.clock.countPending() > 0);

  const readsDuringWait = caller.requests.length;

  ctx.clock.advance(2000);

  const item = await next;

  expect([readsDuringWait, caller.requests.length, toStreamItemSummary(item.value)]).toStrictEqual([
    1,
    2,
    ['event', 'g1.c', null],
  ]);
});

test('it ends with bad_args when the trail refuses the cursor', async () => {
  const ctx = setupTest();

  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('bad_args', 'atc does not take that cursor');
    },
  });

  const stream = await ctx.open(caller, { cursor: 'g1.stale' });

  expect(stream.next()).rejects.toMatchObject({ code: 'bad_args' });
});

test('it reads no further page after the request aborts', async () => {
  const ctx = setupTest();

  const controller = new AbortController();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', ['g1.a']),
    buildMockEventsPage('g1.c', ['g1.c']),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' }, { signal: controller.signal });

  await stream.next();

  controller.abort();

  const done = await stream.next();

  expect([done.done, caller.requests.length]).toStrictEqual([true, 1]);
});

test('it ends a stream that waits on a read when the request aborts', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<Record<string, unknown>>();
  const caller = buildStubFleetCaller({ answer: () => pending.promise });

  const controller = new AbortController();

  const stream = await ctx.open(caller, { cursor: 'g1.0' }, { signal: controller.signal });

  const next = stream.next();

  controller.abort();

  const result = await next;

  expect(result.done).toBe(true);
});

test('it refuses a caller without the read scope before it reads the trail', () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller();

  expect(ctx.open(caller, {}, {}, ['message'])).rejects.toMatchObject({
    code: 'insufficient_scope',
    data: { required: ['read'] },
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it fails an item that does not match the contract as internal', async () => {
  const ctx = setupTest();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', [], { events: [{ cursor: 'g1.a', at: 'late' }] }),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });

  expect(stream.next()).rejects.toMatchObject({ code: 'internal' });
});

test('it keeps the keys a newer daemon adds to an event', async () => {
  const ctx = setupTest();

  const caller = buildPagedFleetCaller([
    buildMockEventsPage('g1.b', [], {
      events: [{ ...buildMockFleetEvent('g1.a'), addedLater: 1 }],
    }),
  ]);

  const stream = await ctx.open(caller, { cursor: 'g1.0' });
  const first = await stream.next();

  expect(first.value).toMatchObject({ kind: 'event', event: { addedLater: 1 } });
});

test('it streams one daemon trail through the local contract', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ events: [buildMockFleetEvent('c1')], cursor: 'c1', more: false }),
  });

  const router = createFleetRouter({ caller, contract: LOCAL_FLEET_CONTRACT });
  const client = createRouterClient(router, { context: { principal: null, scopes: ['read'] } });

  const stream = await client.events.stream({ cursor: 'c0' });
  const first = await stream.next();

  expect(toStreamItemSummary(first.value)).toStrictEqual(['event', 'c1', null]);
});
