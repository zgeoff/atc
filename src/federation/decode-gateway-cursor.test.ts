import { expect, test } from 'bun:test';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';

test('it decodes each registry daemon position an encoded cursor holds', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
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
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const filter = buildEventsFilterHash(null, null);
  const cursor = encodeGatewayCursor(filter, new Map([['gone.11111111', 'c']]));

  expect(decodeGatewayCursor(cursor, filter, registry)).toStrictEqual(new Map());
});

test('it refuses a cursor over 4 KiB with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = 'a'.repeat(4097);

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({ code: 'bad_args', message: 'cursor exceeds 4096 bytes' }),
  );
});

test('it refuses a cursor that is not JSON with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = 'not-a-cursor';

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "'not-a-cursor' is not an events cursor",
    }),
  );
});

test('it refuses a cursor of another version with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = Buffer.from(JSON.stringify({ v: 2, filter: 'f', daemons: {} })).toString(
    'base64url',
  );

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: 'the events cursor has a version this gateway does not read',
    }),
  );
});

test('it refuses a cursor read under other filters with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = Buffer.from(JSON.stringify({ v: 1, filter: 'other', daemons: {} })).toString(
    'base64url',
  );

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: 'the events cursor was read under other filters',
    }),
  );
});

test('it refuses a part with a stale incarnation with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = Buffer.from(
    JSON.stringify({ v: 1, filter: 'f', daemons: { 'cloud.11111111': 'c' } }),
  ).toString('base64url');

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "the events cursor holds a stale position for daemon 'cloud'",
    }),
  );
});

test('it refuses a part whose position is not a cursor with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = Buffer.from(
    JSON.stringify({ v: 1, filter: 'f', daemons: { 'cloud.0f6c2a8e': 7 } }),
  ).toString('base64url');

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "the events cursor holds a stale position for daemon 'cloud'",
    }),
  );
});

test('it refuses a part without an incarnation with bad_args', () => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  const cursor = Buffer.from(
    JSON.stringify({ v: 1, filter: 'f', daemons: { cloud: 'c' } }),
  ).toString('base64url');

  expect(() => decodeGatewayCursor(cursor, 'f', registry)).toThrow(
    expect.objectContaining({ code: 'bad_args', message: `'${cursor}' is not an events cursor` }),
  );
});
