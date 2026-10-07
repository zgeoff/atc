import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { mergeEventPages } from './merge-event-pages';

/**
 * Two real daemons, `cloud` and `pc`, each with one session,
 * `cloudSession` and `pcSession`, that a message writes an event for. The
 * merge tests that need a daemon's own cursor semantics read through them.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const cloud = await startTestDaemon({
    prefix: 'atc-merge-events-cloud-',

    // Session messages need an adapter that takes them.
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  stack.use(cloud);

  const pc = await startTestDaemon({
    prefix: 'atc-merge-events-pc-',

    // Session messages need an adapter that takes them.
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  stack.use(pc);

  const cloudSpawned = await cloud.client.sendRequest('session.spawn', {
    cwd: cloud.dir,
    resume: `a-${randomUUID()}`,
  });

  const pcSpawned = await pc.client.sendRequest('session.spawn', {
    cwd: pc.dir,
    resume: `a-${randomUUID()}`,
  });

  const owned = stack.move();

  return {
    cloud,
    pc,
    cloudSession: String(getRecord(cloudSpawned, 'session')['id']),
    pcSession: String(getRecord(pcSpawned, 'session')['id']),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test("it interleaves daemons by timestamp and keeps a daemon's own order when its clock steps back", () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [
            { cursor: 'eyJrIjoiZXYiLCJpIjoxfQ', at: 10, session: 's1', kind: 'state' },
            { cursor: 'eyJrIjoiZXYiLCJpIjoyfQ', at: 5, session: 's1', kind: 'state' },
          ],
          cursor: 'eyJrIjoiZXYiLCJpIjoyfQ',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxMX0', at: 7, session: 's9', kind: 'state' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxMX0',
          more: false,
        },
      },
    ],
    'f',
    10,
  );

  expect(merged.events).toStrictEqual([
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam93ZlEiLCJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TVgwIn19',
      at: 7,
      session: 'pc.9a1b2c3d.s9',
      kind: 'state',
    },
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam94ZlEiLCJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TVgwIn19',
      at: 10,
      session: 'cloud.0f6c2a8e.s1',
      kind: 'state',
    },
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam95ZlEiLCJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TVgwIn19',
      at: 5,
      session: 'cloud.0f6c2a8e.s1',
      kind: 'state',
    },
  ]);

  expect(merged.more).toBeFalse();
});

test('it gives events of one timestamp to the daemon whose name sorts first', () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxMX0', at: 7, session: 's9' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxMX0',
          more: false,
        },
      },
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxfQ', at: 7, session: 's1' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxfQ',
          more: false,
        },
      },
    ],
    'f',
    10,
  );

  expect(merged.events).toStrictEqual([
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TUgwIiwiY2xvdWQuMGY2YzJhOGUiOiJleUpySWpvaVpYWWlMQ0pwSWpveGZRIn19',
      at: 7,
      session: 'cloud.0f6c2a8e.s1',
    },
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TVgwIiwiY2xvdWQuMGY2YzJhOGUiOiJleUpySWpvaVpYWWlMQ0pwSWpveGZRIn19',
      at: 7,
      session: 'pc.9a1b2c3d.s9',
    },
  ]);
});

test('it advances each daemon only past the events that made the page and reads the cut ones again', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: 'c0' },
        page: {
          kind: 'read',
          events: [
            { cursor: 'eyJrIjoiZXYiLCJpIjoxfQ', at: 1, session: 's1' },
            { cursor: 'eyJrIjoiZXYiLCJpIjozfQ', at: 3, session: 's1' },
          ],
          cursor: 'eyJrIjoiZXYiLCJpIjozfQ',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: 'p0' },
        page: {
          kind: 'read',
          events: [
            { cursor: 'eyJrIjoiZXYiLCJpIjoxMn0', at: 2, session: 's9' },
            { cursor: 'eyJrIjoiZXYiLCJpIjoxNH0', at: 4, session: 's9' },
          ],
          cursor: 'eyJrIjoiZXYiLCJpIjoxNH0',
          more: false,
        },
      },
    ],
    'f',
    2,
  );

  expect(merged.events).toStrictEqual([
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam94ZlEiLCJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TVgwIn19',
      at: 1,
      session: 'cloud.0f6c2a8e.s1',
    },
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam94ZlEiLCJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam94TW4wIn19',
      at: 2,
      session: 'pc.9a1b2c3d.s9',
    },
  ]);

  expect(merged.more).toBeTrue();

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'eyJrIjoiZXYiLCJpIjoxfQ'],
      ['pc', 'eyJrIjoiZXYiLCJpIjoxMn0'],
    ]),
  );
});

test('it gives each event the cursor that resumes right after it', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: 'c0' },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxfQ', at: 1, session: 's1' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxfQ',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: 'p0' },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxMn0', at: 2, session: 's9' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxMn0',
          more: false,
        },
      },
    ],
    'f',
    10,
  );

  expect(decodeGatewayCursor(String(merged.events[0]?.['cursor']), 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'eyJrIjoiZXYiLCJpIjoxfQ'],
      ['pc', 'eyJrIjoiZXYiLCJpIjoxMX0'],
    ]),
  );
});

test('it keeps the position of a daemon that did not answer and lists it as unavailable', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: 'c0' },
        page: { kind: 'unavailable' },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: 'p0' },
        page: { kind: 'read', events: [], cursor: 'p0', more: false },
      },
    ],
    'f',
    10,
  );

  expect(merged.unavailable).toStrictEqual(['cloud']);

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'c0'],
      ['pc', 'p0'],
    ]),
  );
});

test('it leaves a daemon the cursor never held out of the cursor while it does not answer', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: null,
        page: { kind: 'unavailable' },
      },
    ],
    'f',
    10,
  );

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(new Map());
});

test('it lists a daemon that started at its newest event and resumes it from there', () => {
  const registry = {
    daemons: new Map([['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })]]),
    defaultDaemon: 'pc',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: null,
        page: { kind: 'started', cursor: 'p9' },
      },
    ],
    'f',
    10,
  );

  expect(merged.started).toStrictEqual(['pc']);
  expect(merged.events).toStrictEqual([]);
  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(new Map([['pc', 'p9']]));
});

test('it resumes a daemon whose every event was cut right before its first event', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjoxfQ', at: 1, session: 's1' }],
          cursor: 'eyJrIjoiZXYiLCJpIjoxfQ',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'eyJrIjoiZXYiLCJpIjo3fQ', at: 2, session: 's9' }],
          cursor: 'eyJrIjoiZXYiLCJpIjo3fQ',
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'eyJrIjoiZXYiLCJpIjoxfQ'],
      ['pc', 'eyJrIjoiZXYiLCJpIjo2fQ'],
    ]),
  );
});

test('it rewrites the session and message of each event for its daemon', () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [
            {
              cursor: 'eyJrIjoiZXYiLCJpIjoxfQ',
              at: 1,
              session: 's1',
              message: 'm-1',
              kind: 'message',
              detail: 'answered',
            },
          ],
          cursor: 'eyJrIjoiZXYiLCJpIjoxfQ',
          more: true,
        },
      },
    ],
    'f',
    10,
  );

  expect(merged.events).toStrictEqual([
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJjbG91ZC4wZjZjMmE4ZSI6ImV5SnJJam9pWlhZaUxDSnBJam94ZlEifX0',
      at: 1,
      session: 'cloud.0f6c2a8e.s1',
      message: 'cloud.0f6c2a8e.m-1',
      kind: 'message',
      detail: 'answered',
    },
  ]);

  expect(merged.more).toBeTrue();
});

test('it reads an event cut from a page exactly once though the daemon appends another before the next page', async () => {
  await using ctx = await setupTest();

  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  // The cloud event is stamped no later than the pc one, and a tie goes to
  // the daemon whose name sorts first, so the cloud event wins the
  // one-event page.
  await ctx.cloud.client.sendRequest('session.message', {
    session: ctx.cloudSession,
    from: 'tester',
    text: 'first',
  });

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'second',
  });

  const cloudFirst = await ctx.cloud.client.sendRequest('events.read', { limit: 1 });
  const pcFirst = await ctx.pc.client.sendRequest('events.read', { limit: 1 });

  const first = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [cloudFirst['events']].flat().filter((event) => isRecord(event)),
          cursor: String(cloudFirst['cursor']),
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [pcFirst['events']].flat().filter((event) => isRecord(event)),
          cursor: String(pcFirst['cursor']),
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'third',
  });

  const firstParts = decodeGatewayCursor(first.cursor, 'f', registry);

  const cloudSecond = await ctx.cloud.client.sendRequest('events.read', {
    limit: 1,
    cursor: firstParts.get('cloud'),
  });

  const pcSecond = await ctx.pc.client.sendRequest('events.read', {
    limit: 1,
    cursor: firstParts.get('pc'),
  });

  const second = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: String(firstParts.get('cloud')) },
        page: {
          kind: 'read',
          events: [cloudSecond['events']].flat().filter((event) => isRecord(event)),
          cursor: String(cloudSecond['cursor']),
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: String(firstParts.get('pc')) },
        page: {
          kind: 'read',
          events: [pcSecond['events']].flat().filter((event) => isRecord(event)),
          cursor: String(pcSecond['cursor']),
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  expect([...first.events, ...second.events].map((event) => event['detail'])).toStrictEqual([
    'first',
    'second',
  ]);
});

test('it resumes a daemon right after its event a later page read again', async () => {
  await using ctx = await setupTest();

  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  // The cloud event is stamped no later than the pc one, and a tie goes to
  // the daemon whose name sorts first, so the cloud event wins the
  // one-event page and the pc one is cut.
  await ctx.cloud.client.sendRequest('session.message', {
    session: ctx.cloudSession,
    from: 'tester',
    text: 'first',
  });

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'second',
  });

  const pcFirst = await ctx.pc.client.sendRequest('events.read', { limit: 1 });
  const cloudFirst = await ctx.cloud.client.sendRequest('events.read', { limit: 1 });

  const first = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [cloudFirst['events']].flat().filter((event) => isRecord(event)),
          cursor: String(cloudFirst['cursor']),
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [pcFirst['events']].flat().filter((event) => isRecord(event)),
          cursor: String(pcFirst['cursor']),
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'third',
  });

  const pcSecond = await ctx.pc.client.sendRequest('events.read', {
    limit: 1,
    cursor: decodeGatewayCursor(first.cursor, 'f', registry).get('pc'),
  });

  const second = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: String(decodeGatewayCursor(first.cursor, 'f', registry).get('pc')) },
        page: {
          kind: 'read',
          events: [pcSecond['events']].flat().filter((event) => isRecord(event)),
          cursor: String(pcSecond['cursor']),
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  const pcThird = await ctx.pc.client.sendRequest('events.read', {
    limit: 1,
    cursor: decodeGatewayCursor(second.cursor, 'f', registry).get('pc'),
  });

  expect(
    [pcThird['events']]
      .flat()
      .filter((event) => isRecord(event))
      .map((event) => event['detail']),
  ).toStrictEqual(['third']);
});

test('it pins a daemon the cursor leaves out at its newest event and reads only what follows', async () => {
  await using ctx = await setupTest();

  const registry = {
    daemons: new Map([['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })]]),
    defaultDaemon: 'pc',
  };

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'old',
  });

  const newest = await ctx.pc.client.sendRequest('events.read', { limit: 1 });

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: null,
        page: { kind: 'started', cursor: String(newest['cursor']) },
      },
    ],
    'f',
    10,
  );

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'new',
  });

  const after = await ctx.pc.client.sendRequest('events.read', {
    cursor: decodeGatewayCursor(merged.cursor, 'f', registry).get('pc'),
  });

  expect(
    [after['events']]
      .flat()
      .filter((event) => isRecord(event))
      .map((event) => event['detail']),
  ).toStrictEqual(['new']);
});

test('it reads the events a daemon queued while it was down once it answers at its latest events', async () => {
  await using ctx = await setupTest();

  await ctx.pc.client.sendRequest('session.message', {
    session: ctx.pcSession,
    from: 'tester',
    text: 'queued',
  });

  const latest = await ctx.pc.client.sendRequest('events.read', {});

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [latest['events']].flat().filter((event) => isRecord(event)),
          cursor: String(latest['cursor']),
          more: false,
        },
        unstarted: { olderUnread: false },
      },
    ],
    'f',
    50,
  );

  expect(merged.events.map((event) => event['detail'])).toContain('queued');
  expect(merged.started).toStrictEqual(['pc']);
  expect(merged.truncated).toStrictEqual([]);
});

test('it keeps a null position for a daemon that has not answered since the cursor started', () => {
  const registry = {
    daemons: new Map([['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })]]),
    defaultDaemon: 'pc',
  };

  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: { kind: 'unavailable' },
      },
    ],
    'f',
    50,
  );

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(new Map([['pc', null]]));
});

test('it lists a daemon whose latest page after a gap left older events unread as truncated', () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: { kind: 'read', events: [], cursor: 'p9', more: false },
        unstarted: { olderUnread: true },
      },
    ],
    'f',
    10,
  );

  expect(merged.started).toStrictEqual(['pc']);
  expect(merged.truncated).toStrictEqual(['pc']);
});

test("it gives a report event its daemon's own cursor as a qualified report handle beside the merged cursor", () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [
            {
              cursor: 'eyJrIjoiZXYiLCJpIjo3fQ',
              at: 1,
              session: 's1',
              kind: 'report',
              label: 'decision',
              detail: 'done',
            },
          ],
          cursor: 'eyJrIjoiZXYiLCJpIjo3fQ',
          more: false,
        },
      },
    ],
    'f',
    10,
  );

  expect(merged.events).toStrictEqual([
    {
      cursor:
        'eyJ2IjoxLCJmaWx0ZXIiOiJmIiwiZGFlbW9ucyI6eyJwYy45YTFiMmMzZCI6ImV5SnJJam9pWlhZaUxDSnBJam8zZlEifX0',
      at: 1,
      session: 'pc.9a1b2c3d.s1',
      kind: 'report',
      label: 'decision',
      detail: 'done',
      report: 'pc.9a1b2c3d.eyJrIjoiZXYiLCJpIjo3fQ',
    },
  ]);
});
