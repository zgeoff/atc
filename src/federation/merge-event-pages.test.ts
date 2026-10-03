import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { mergeEventPages } from './merge-event-pages';

/**
 * Two real daemons, `cloud` and `pc`, each with one session and its owner
 * connection. `sendMessage` writes one message event to a daemon's trail.
 * The merge tests that need a daemon's own cursor semantics read through
 * them.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-merge-events-');
  const daemons: { readonly stop: () => Promise<void> }[] = [];

  const owners = new Map<string, { readonly client: DaemonClient; readonly session: string }>();

  for (const name of ['cloud', 'pc']) {
    mkdirSync(join(tmp.dir, name));

    const daemon = await startDaemon({
      socketPath: join(tmp.dir, name, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, name, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(tmp.dir, name, 'state.db'),
      statusPath: join(tmp.dir, name, 'status.json'),
    });

    daemons.push(daemon);

    const client = await DaemonClient.open(join(tmp.dir, name, 'daemon.sock'));

    await client.sendHello('atc/test-build');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: '/tmp',
      resume: `a-${randomUUID()}`,
    });

    owners.set(name, { client, session: String(getRecord(spawned, 'session')['id']) });
  }

  const getOwner = (name: string) => {
    const owner = owners.get(name);

    if (owner === undefined) {
      throw new Error(`no daemon '${name}'`);
    }

    return owner;
  };

  return {
    client: (name: string) => getOwner(name).client,
    async sendMessage(name: string, text: string): Promise<void> {
      const owner = getOwner(name);

      await owner.client.sendRequest('session.message', {
        session: owner.session,
        from: 'tester',
        text,
      });
    },
    async [Symbol.asyncDispose]() {
      for (const owner of owners.values()) {
        owner.client.stop();
      }

      for (const daemon of daemons) {
        await daemon.stop();
      }

      tmp[Symbol.dispose]();
    },
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

  expect(merged.events.map((event) => [event['session'], event['at']])).toStrictEqual([
    ['pc.9a1b2c3d.s9', 7],
    ['cloud.0f6c2a8e.s1', 10],
    ['cloud.0f6c2a8e.s1', 5],
  ]);

  expect(merged.more).toBeFalse();
});

test('it advances each daemon only past the events that made the page and reads the cut ones again', () => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
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

  expect(merged.events.map((event) => event['session'])).toStrictEqual([
    'cloud.0f6c2a8e.s1',
    'pc.9a1b2c3d.s9',
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
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
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
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
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
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
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
    daemons: new Map([
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
    ]),
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
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
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
      cursor: expect.toBeString(),
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
  await using daemons = await setupTest();

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: 'h', port: 1 },
          daemonID: 'd1',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  await daemons.sendMessage('cloud', 'first');

  // The pc event must carry a later timestamp than the cloud one, so the
  // cloud event wins the one-event page.
  await Bun.sleep(5);
  await daemons.sendMessage('pc', 'second');

  const cloudFirst = await daemons.client('cloud').sendRequest('events.read', { limit: 1 });
  const pcFirst = await daemons.client('pc').sendRequest('events.read', { limit: 1 });

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

  await daemons.sendMessage('pc', 'third');

  const firstParts = decodeGatewayCursor(first.cursor, 'f', registry);

  const cloudSecond = await daemons
    .client('cloud')
    .sendRequest('events.read', { limit: 1, cursor: firstParts.get('cloud') });

  const pcSecond = await daemons
    .client('pc')
    .sendRequest('events.read', { limit: 1, cursor: firstParts.get('pc') });

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

  const secondParts = decodeGatewayCursor(second.cursor, 'f', registry);

  const pcThird = await daemons
    .client('pc')
    .sendRequest('events.read', { limit: 1, cursor: secondParts.get('pc') });

  expect(
    [first, second].flatMap((page) => page.events.map((event) => event['detail'])),
  ).toStrictEqual(['first', 'second']);

  expect(
    [pcThird['events']]
      .flat()
      .filter((event) => isRecord(event))
      .map((event) => event['detail']),
  ).toStrictEqual(['third']);
});

test('it pins a daemon the cursor leaves out at its newest event and reads only what follows', async () => {
  await using daemons = await setupTest();

  const registry = {
    daemons: new Map([
      [
        'pc',
        {
          name: 'pc',
          address: { host: 'h', port: 2 },
          daemonID: 'd2',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'pc',
  };

  await daemons.sendMessage('pc', 'old');

  const newest = await daemons.client('pc').sendRequest('events.read', { limit: 1 });

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

  await daemons.sendMessage('pc', 'new');

  const after = await daemons.client('pc').sendRequest('events.read', {
    cursor: decodeGatewayCursor(merged.cursor, 'f', registry).get('pc'),
  });

  expect(merged.started).toStrictEqual(['pc']);

  expect(
    [after['events']]
      .flat()
      .filter((event) => isRecord(event))
      .map((event) => event['detail']),
  ).toStrictEqual(['new']);
});
