import { expect, test } from 'bun:test';
import { createFleetRouter } from '@atc/fleet-api';
import { buildMockEventsPage } from '@atc/fleet-api/test-utils/build-mock-events-page';
import { buildPagedFleetCaller } from '@atc/fleet-api/test-utils/build-paged-fleet-caller';
import { buildStubFleetCaller } from '@atc/fleet-api/test-utils/build-stub-fleet-caller';
import { FLEET_CONTRACT, GRANT_SCOPES } from '@atcx/contract';
import { AtcError, CONTRACT_MAJOR } from '@atcx/contract/light';
import type { SecurityEvent } from '@zgeoff/mcp-auth';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createFakeClock } from '@zgeoff/testing/clock';
import type { VerifiedAccess } from '../auth/types';
import { buildMockServiceAccess } from '../test-utils/build-mock-service-access';
import { buildRPCRequest } from '../test-utils/build-rpc-request';
import { readEventStream } from '../test-utils/read-event-stream';
import { createRPCRoute } from './create-rpc-route';

interface RouteSetup {
  readonly caller: ReturnType<typeof buildStubFleetCaller>;
  readonly verify?: (bearer: string) => Promise<VerifiedAccess | null>;
  readonly keepAliveMs?: number;
}

function setupTest() {
  const clock = createFakeClock();
  const security: SecurityEvent[] = [];
  const allAccess = buildMockServiceAccess(GRANT_SCOPES);

  return {
    clock,
    security,
    allAccess,
    createRoute: (setup: RouteSetup) =>
      createRPCRoute({
        router: createFleetRouter({ caller: setup.caller, contract: FLEET_CONTRACT, clock }),
        verify:
          setup.verify ??
          ((bearer) => {
            const found = bearer === 'good' ? allAccess : null;

            return Promise.resolve(found);
          }),
        clock,
        security: {
          record: (event) => {
            security.push(event);
          },
        },
        hosts: new Set(['gateway.test']),
        origins: new Set(['https://gateway.test']),
        readRequester: () => ({ socketAddress: null, connectingIP: null, userAgent: null }),
        origin: 'https://gateway.test',
        keepAliveMs: setup.keepAliveMs,
      }),
  };
}

test('it answers a procedure of the router as the verified principal', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller({ answer: () => ({ dirs: ['/work'] }) });
  const route = ctx.createRoute({ caller });

  const response = await route(buildRPCRequest('dirs/list', {}, 'good'));

  expect([response.status, await response.json(), caller.requests]).toStrictEqual([
    200,
    { json: { dirs: ['/work'] } },
    [
      {
        method: 'dirs.list',
        params: {},
        principal: { id: 'service:ci', name: 'service:ci' },
      },
    ],
  ]);
});

test('it answers 401 with the challenge /mcp sends and records a bearer event when the header is missing', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller();
  const route = ctx.createRoute({ caller });

  const response = await route(buildRPCRequest('dirs/list', {}, null));

  expect([
    response.status,
    response.headers.get('www-authenticate'),
    ctx.security,
    caller.requests,
  ]).toStrictEqual([
    401,
    'Bearer resource_metadata="https://gateway.test/.well-known/oauth-protected-resource/mcp"',
    [
      {
        kind: 'bearer',
        outcome: 'rejected',
        reason: 'missing',
        path: '/rpc/dirs/list',
        requester: { socketAddress: null, connectingIP: null, userAgent: null },
      },
    ],
    [],
  ]);
});

test('it answers 401 with the invalid_token challenge for a bearer that does not verify', async () => {
  const ctx = setupTest();
  const route = ctx.createRoute({ caller: buildStubFleetCaller() });

  const response = await route(buildRPCRequest('dirs/list', {}, 'bad'));

  expect([
    response.status,
    response.headers.get('www-authenticate'),
    ctx.security.map((event) => event.reason),
  ]).toStrictEqual([
    401,
    'Bearer error="invalid_token", resource_metadata="https://gateway.test/.well-known/oauth-protected-resource/mcp"',
    ['invalid_token'],
  ]);
});

test('it reads no token from a query string, and records neither the query nor an extra path', async () => {
  const ctx = setupTest();
  const route = ctx.createRoute({ caller: buildStubFleetCaller() });

  const queried = await route(buildRPCRequest('dirs/list', {}, null, { search: '?token=good' }));
  const extra = await route(buildRPCRequest('dirs/list/secret-name', {}, null));

  expect([queried.status, extra.status, ctx.security.map((event) => event.path)]).toStrictEqual([
    401,
    401,
    ['/rpc/dirs/list', '/rpc'],
  ]);
});

test('it refuses a host outside the allowed set before it reads the bearer', async () => {
  const ctx = setupTest();
  const verified: string[] = [];

  const route = ctx.createRoute({
    caller: buildStubFleetCaller(),
    verify: (bearer) => {
      verified.push(bearer);

      return Promise.resolve(null);
    },
  });

  const response = await route(buildRPCRequest('dirs/list', {}, 'good', { host: 'evil.test' }));

  expect([response.status, verified, ctx.security.map((event) => event.kind)]).toStrictEqual([
    403,
    [],
    ['bad_host'],
  ]);
});

test('it refuses a foreign origin before it reads the bearer', async () => {
  const ctx = setupTest();
  const verified: string[] = [];

  const route = ctx.createRoute({
    caller: buildStubFleetCaller(),
    verify: (bearer) => {
      verified.push(bearer);

      return Promise.resolve(null);
    },
  });

  const response = await route(
    buildRPCRequest('dirs/list', {}, 'good', { headers: { origin: 'https://evil.test' } }),
  );

  expect([response.status, verified, ctx.security.map((event) => event.kind)]).toStrictEqual([
    403,
    [],
    ['bad_origin'],
  ]);
});

test('it accepts an allowed origin', async () => {
  const ctx = setupTest();
  const route = ctx.createRoute({ caller: buildStubFleetCaller({ answer: () => ({ dirs: [] }) }) });

  const response = await route(
    buildRPCRequest('dirs/list', {}, 'good', { headers: { origin: 'https://gateway.test' } }),
  );

  expect(response.status).toBe(200);
});

test.each([
  { title: 'is missing', headers: { 'x-atc-major': '' }, drop: true },
  {
    title: 'is another major',
    headers: { 'x-atc-major': String(CONTRACT_MAJOR + 1) },
    drop: false,
  },
  { title: 'is no number', headers: { 'x-atc-major': 'seven' }, drop: false },
])(
  'it answers protocol_mismatch with the gateway major and runs nothing when x-atc-major $title',
  async (row) => {
    const ctx = setupTest();
    const caller = buildStubFleetCaller();
    const route = ctx.createRoute({ caller });
    const request = buildRPCRequest('dirs/list', {}, 'good', { headers: row.headers });

    if (row.drop) {
      request.headers.delete('x-atc-major');
    }

    const response = await route(request);
    const body: unknown = await response.json();

    expect([response.status, body, caller.requests]).toStrictEqual([
      500,
      {
        json: {
          defined: true,
          code: 'protocol_mismatch',
          status: 500,
          message: expect.toBeString(),
          data: { gatewayMajor: CONTRACT_MAJOR },
        },
      },
      [],
    ]);
  },
);

test('it refuses a procedure the token lacks the scope for, with the required scope', async () => {
  const ctx = setupTest();
  const caller = buildStubFleetCaller();

  const route = ctx.createRoute({
    caller,
    verify: () => Promise.resolve(buildMockServiceAccess(['read', 'message', 'spawn'])),
  });

  const response = await route(
    buildRPCRequest('session/kill', { session: 'build-box.k3f9.s7-m4x2p' }, 'good'),
  );

  expect([response.status, await response.json(), caller.requests]).toStrictEqual([
    500,
    {
      json: {
        defined: true,
        code: 'insufficient_scope',
        status: 500,
        message: 'this token lacks the kill scope',
        data: { required: ['kill'] },
      },
    },
    [],
  ]);
});

test('it passes the code, message, problem, required and effectRef of an error and drops every other data field', async () => {
  const ctx = setupTest();

  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('outcome_unknown', 'the daemon never answered', {
        problem: 'host_asleep',
        effectRef: 'build-box.k3f9.s7-m4x2p',
        required: ['spawn'],
        daemon: 'build-box',
        path: '/secret/place',
      });
    },
  });

  const route = ctx.createRoute({ caller });

  const response = await route(
    buildRPCRequest(
      'session/message',
      { session: 'a.b.c', text: 'hi', idempotencyKey: 'k' },
      'good',
    ),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: {
      defined: true,
      code: 'outcome_unknown',
      status: 500,
      message: 'the daemon never answered',
      data: { problem: 'host_asleep', effectRef: 'build-box.k3f9.s7-m4x2p', required: ['spawn'] },
    },
  });
});

test('it drops an effectRef that the key binding restored from its cache', async () => {
  const ctx = setupTest();

  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('outcome_unknown', 'the daemon never answered', {
        effectRef: 'build-box.k3f9.s7-m4x2p',
        effectRefIsCached: true,
      });
    },
  });

  const route = ctx.createRoute({ caller });

  const response = await route(
    buildRPCRequest(
      'session/message',
      { session: 'a.b.c', text: 'hi', idempotencyKey: 'k' },
      'good',
    ),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: {
      defined: true,
      code: 'outcome_unknown',
      status: 500,
      message: 'the daemon never answered',
    },
  });
});

test('it answers 404 to a path that names no procedure', async () => {
  const ctx = setupTest();
  const route = ctx.createRoute({ caller: buildStubFleetCaller() });

  const response = await route(buildRPCRequest('nothing/here', {}, 'good'));

  expect(response.status).toBe(404);
});

test('it streams the trail with each event id on the wire', async () => {
  const ctx = setupTest();
  const caller = buildPagedFleetCaller([buildMockEventsPage('g1.b', ['g1.a', 'g1.b'])]);
  const route = ctx.createRoute({ caller });

  const controller = new AbortController();

  const response = await route(
    buildRPCRequest('events/stream', { cursor: 'g1.0' }, 'good', { signal: controller.signal }),
  );

  const read = await readEventStream(response, { messages: 2 });

  controller.abort();

  expect(read.messages.map((message) => [message.event, message.id])).toStrictEqual([
    ['message', 'g1.a'],
    ['message', 'g1.b'],
  ]);
});

test('it sends the keep-alive comment on the interval it is given', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<Record<string, unknown>>();
  const caller = buildStubFleetCaller({ answer: () => pending.promise });
  const route = ctx.createRoute({ caller, keepAliveMs: 20 });

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const response = await route(
    buildRPCRequest('events/stream', { cursor: 'g1.0' }, 'good', { signal: controller.signal }),
  );

  const read = await readEventStream(response, { comments: 3 });

  expect(read.comments).toBe(3);
});

test('it refuses the ninth open stream of a principal with too_many_streams and not the eighth', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<Record<string, unknown>>();
  const caller = buildStubFleetCaller({ answer: () => pending.promise });
  const route = ctx.createRoute({ caller });

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const open = () =>
    route(
      buildRPCRequest('events/stream', { cursor: 'g1.0' }, 'good', { signal: controller.signal }),
    );

  const first = await Promise.all(Array.from({ length: 8 }, () => open()));
  const ninth = await open();

  expect([
    first.map((response) => response.status),
    ninth.status,
    await ninth.json(),
  ]).toStrictEqual([
    Array.from({ length: 8 }, () => 200),
    500,
    {
      json: {
        defined: true,
        code: 'too_many_streams',
        status: 500,
        message: expect.toBeString(),
      },
    },
  ]);
});

test('it counts the streams of each principal on its own', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<Record<string, unknown>>();
  const caller = buildStubFleetCaller({ answer: () => pending.promise });

  const route = ctx.createRoute({
    caller,
    verify: (bearer) => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES, bearer)),
  });

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const open = (bearer: string) =>
    route(
      buildRPCRequest('events/stream', { cursor: 'g1.0' }, bearer, { signal: controller.signal }),
    );

  await Promise.all(Array.from({ length: 8 }, () => open('one')));

  const other = await open('two');

  expect(other.status).toBe(200);
});

test('it frees the place of a stream whose client disconnects, so nine reconnects in a row never hit the limit', async () => {
  const ctx = setupTest();
  const caller = buildPagedFleetCaller([]);
  const route = ctx.createRoute({ caller });
  const statuses: number[] = [];

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const controller = new AbortController();

    const response = await route(
      buildRPCRequest('events/stream', { cursor: 'g1.0' }, 'good', { signal: controller.signal }),
    );

    statuses.push(response.status);
    controller.abort();

    await response.body?.cancel();
  }

  expect(statuses).toStrictEqual(Array.from({ length: 9 }, () => 200));
});

test('it frees the place of a stream that ends by itself', async () => {
  const ctx = setupTest();

  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('bad_args', 'atc does not take that cursor');
    },
  });

  const route = ctx.createRoute({ caller });
  const statuses: number[] = [];

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await route(buildRPCRequest('events/stream', { cursor: 'g1.x' }, 'good'));

    await readEventStream(response, { messages: 1 });

    statuses.push(response.status);
  }

  expect(statuses).toStrictEqual(Array.from({ length: 9 }, () => 200));
});

test('it ends a stream with bad_args as an error event when the trail refuses its cursor', async () => {
  const ctx = setupTest();

  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('bad_args', 'atc does not take that cursor', { daemon: 'build-box' });
    },
  });

  const route = ctx.createRoute({ caller });

  const response = await route(buildRPCRequest('events/stream', { cursor: 'g1.x' }, 'good'));
  const read = await readEventStream(response, { messages: 1 });

  expect(read.messages).toStrictEqual([
    {
      event: 'error',
      id: null,
      data: {
        json: {
          defined: true,
          code: 'bad_args',
          status: 500,
          message: 'atc does not take that cursor',
        },
      },
    },
  ]);
});

test('it ends a stream when its bearer no longer verifies, sending nothing after the failed check', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<Record<string, unknown>>();
  const caller = buildStubFleetCaller({ answer: () => pending.promise });
  let isValid = true;

  const verify = (): Promise<VerifiedAccess | null> => {
    const found = isValid ? ctx.allAccess : null;

    return Promise.resolve(found);
  };

  const route = ctx.createRoute({ caller, verify });

  const response = await route(buildRPCRequest('events/stream', { cursor: 'g1.0' }, 'good'));

  const read = readEventStream(response, { messages: 1 });

  await waitFor(() => ctx.clock.countPending() > 0);

  isValid = false;

  ctx.clock.advance(60_000);

  const ended = await read;

  expect(ended.messages.map((message) => message.event)).toStrictEqual(['done']);
});
