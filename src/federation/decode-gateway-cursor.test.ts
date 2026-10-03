import { expect, test } from 'bun:test';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';

test('it decodes each registry daemon position an encoded cursor holds', () => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '100.64.0.2', port: 8415 },
          daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: '100.64.0.3', port: 8415 },
          daemonID: '9a1b2c3d-0000-4000-8000-000000000001',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash(null, null);

  const cursor = encodeGatewayCursor(
    filter,
    new Map([
      ['cloud.0f6c2a8e', 'eyJrIjoiZXYiLCJpIjo0fQ'],
      ['pc.9a1b2c3d', 'eyJrIjoiZXYiLCJpIjowfQ'],
    ]),
  );

  expect(decodeGatewayCursor(cursor, filter, registry)).toStrictEqual(
    new Map([
      ['cloud', 'eyJrIjoiZXYiLCJpIjo0fQ'],
      ['pc', 'eyJrIjoiZXYiLCJpIjowfQ'],
    ]),
  );
});

test('it drops the part of a daemon the registry no longer lists', () => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '100.64.0.2', port: 8415 },
          daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash(null, null);
  const cursor = encodeGatewayCursor(filter, new Map([['gone.11111111', 'c']]));

  expect(decodeGatewayCursor(cursor, filter, registry)).toStrictEqual(new Map());
});

test.each([
  ['a cursor over 4 KiB', 'a'.repeat(4097), 'cursor exceeds 4096 bytes'],
  ['a cursor that is not JSON', 'not-a-cursor', "'not-a-cursor' is not an events cursor"],
  [
    'a cursor of another version',
    Buffer.from(JSON.stringify({ v: 2, filter: 'f', daemons: {} })).toString('base64url'),
    'the events cursor has a version this gateway does not read',
  ],
  [
    'a cursor read under other filters',
    Buffer.from(JSON.stringify({ v: 1, filter: 'other', daemons: {} })).toString('base64url'),
    'the events cursor was read under other filters',
  ],
  [
    'a part with a stale incarnation',
    Buffer.from(JSON.stringify({ v: 1, filter: 'f', daemons: { 'cloud.11111111': 'c' } })).toString(
      'base64url',
    ),
    "the events cursor holds a stale position for daemon 'cloud'",
  ],
  [
    'a part whose position is not a cursor',
    Buffer.from(JSON.stringify({ v: 1, filter: 'f', daemons: { 'cloud.0f6c2a8e': 7 } })).toString(
      'base64url',
    ),
    "the events cursor holds a stale position for daemon 'cloud'",
  ],
  [
    'a part without an incarnation',
    Buffer.from(JSON.stringify({ v: 1, filter: 'f', daemons: { cloud: 'c' } })).toString(
      'base64url',
    ),
    expect.toInclude('is not an events cursor'),
  ],
])('it refuses %s with bad_args', (_label, cursor, message) => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '100.64.0.2', port: 8415 },
          daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({ code: 'bad_args', message }),
  );
});

test('it hashes the same filters the same way whatever the kind order', () => {
  expect(buildEventsFilterHash('cloud.0f6c2a8e.s1', ['b', 'a'])).toBe(
    buildEventsFilterHash('cloud.0f6c2a8e.s1', ['a', 'b']),
  );
});

test('it hashes a session filter apart from no filter', () => {
  expect(buildEventsFilterHash('cloud.0f6c2a8e.s1', null)).not.toBe(
    buildEventsFilterHash(null, null),
  );
});
