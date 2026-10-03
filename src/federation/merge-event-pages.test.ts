import { expect, test } from 'bun:test';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { mergeEventPages } from './merge-event-pages';

test("it interleaves daemons by timestamp and keeps a daemon's own order when its clock steps back", () => {
  const merged = mergeEventPages(
    [
      {
        daemon: { name: 'cloud', incarnation: '0f6c2a8e' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [
            { cursor: 'c1', at: 10, session: 's1', kind: 'state' },
            { cursor: 'c2', at: 5, session: 's1', kind: 'state' },
          ],
          cursor: 'c2',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'p1', at: 7, session: 's9', kind: 'state' }],
          cursor: 'p1',
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
            { cursor: 'c1', at: 1, session: 's1' },
            { cursor: 'c3', at: 3, session: 's1' },
          ],
          cursor: 'c3',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: 'p0' },
        page: {
          kind: 'read',
          events: [
            { cursor: 'p2', at: 2, session: 's9' },
            { cursor: 'p4', at: 4, session: 's9' },
          ],
          cursor: 'p4',
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
      ['cloud', 'c1'],
      ['pc', 'p2'],
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
          events: [{ cursor: 'c1', at: 1, session: 's1' }],
          cursor: 'c1',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: 'p0' },
        page: {
          kind: 'read',
          events: [{ cursor: 'p2', at: 2, session: 's9' }],
          cursor: 'p2',
          more: false,
        },
      },
    ],
    'f',
    10,
  );

  expect(decodeGatewayCursor(String(merged.events[0]?.['cursor']), 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'c1'],
      ['pc', 'p0'],
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

test('it keeps the start position of a daemon whose every event was cut', () => {
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
          events: [{ cursor: 'c1', at: 1, session: 's1' }],
          cursor: 'c1',
          more: false,
        },
      },
      {
        daemon: { name: 'pc', incarnation: '9a1b2c3d' },
        before: { cursor: null },
        page: {
          kind: 'read',
          events: [{ cursor: 'p2', at: 2, session: 's9' }],
          cursor: 'p2',
          more: false,
        },
      },
    ],
    'f',
    1,
  );

  expect(decodeGatewayCursor(merged.cursor, 'f', registry)).toStrictEqual(
    new Map([
      ['cloud', 'c1'],
      ['pc', null],
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
              cursor: 'c1',
              at: 1,
              session: 's1',
              message: 'm-1',
              kind: 'message',
              detail: 'answered',
            },
          ],
          cursor: 'c1',
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
