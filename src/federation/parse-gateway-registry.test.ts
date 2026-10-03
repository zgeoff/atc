import { expect, test } from 'bun:test';
import { encodeCursor } from '../protocol/encode-cursor';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { decodeGatewayCursor } from './decode-gateway-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { parseGatewayRegistry } from './parse-gateway-registry';

test('it parses a registry with its pins, incarnations, and tokens', () => {
  const parsed = parseGatewayRegistry(
    {
      daemons: {
        cloud: { address: '100.69.47.33:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
        'pc-1': {
          address: '[fd7a:115c:a1e4::7]:8415',
          daemonID: '9a1b2c3d-0000-4000-8000-000000000001',
        },
      },
      defaultDaemon: 'cloud',
    },
    { ATC_GATEWAY_TOKEN_CLOUD: 'cloud-token', ATC_GATEWAY_TOKEN_PC_1: 'pc-token' },
  );

  expect(parsed).toStrictEqual({
    ok: true,
    registry: {
      daemons: new Map([
        [
          'cloud',
          {
            name: 'cloud',
            address: { host: '100.69.47.33', port: 8415 },
            daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
            incarnation: '0f6c2a8e',
            token: 'cloud-token',
          },
        ],
        [
          'pc-1',
          {
            name: 'pc-1',
            address: { host: 'fd7a:115c:a1e4::7', port: 8415 },
            daemonID: '9a1b2c3d-0000-4000-8000-000000000001',
            incarnation: '9a1b2c3d',
            token: 'pc-token',
          },
        ],
      ]),
      defaultDaemon: 'cloud',
    },
  });
});

test('it refuses a registry whose daemon has no token variable', () => {
  const parsed = parseGatewayRegistry(
    {
      daemons: {
        'pc-1': { address: '100.64.0.2:8415', daemonID: '9a1b2c3d-0000-4000-8000-000000000001' },
      },
      defaultDaemon: 'pc-1',
    },
    {},
  );

  expect(parsed).toStrictEqual({
    ok: false,
    errors: ["daemon 'pc-1' has no token: set ATC_GATEWAY_TOKEN_PC_1"],
  });
});

test('it refuses a registry without defaultDaemon', () => {
  const parsed = parseGatewayRegistry(
    {
      daemons: {
        cloud: { address: '100.64.0.2:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
      },
    },
    { ATC_GATEWAY_TOKEN_CLOUD: 't' },
  );

  expect(parsed).toStrictEqual({
    ok: false,
    errors: ['defaultDaemon is required and must name a daemon in the registry'],
  });
});

test('it refuses a defaultDaemon that is not in the registry', () => {
  const parsed = parseGatewayRegistry(
    {
      daemons: {
        cloud: { address: '100.64.0.2:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
      },
      defaultDaemon: 'pc',
    },
    { ATC_GATEWAY_TOKEN_CLOUD: 't' },
  );

  expect(parsed).toStrictEqual({
    ok: false,
    errors: ["defaultDaemon 'pc' is not a daemon in the registry"],
  });
});

test.each([
  ['Cloud', "daemon name 'Cloud' must match ^[a-z][a-z0-9-]{0,30}$"],
  ['cloud.two', "daemon name 'cloud.two' must match ^[a-z][a-z0-9-]{0,30}$"],
  ['1cloud', "daemon name '1cloud' must match ^[a-z][a-z0-9-]{0,30}$"],
  [`c${'x'.repeat(31)}`, `daemon name 'c${'x'.repeat(31)}' must match ^[a-z][a-z0-9-]{0,30}$`],
])('it refuses the daemon name %p', (name, error) => {
  const parsed = parseGatewayRegistry(
    {
      daemons: {
        [name]: { address: '100.64.0.2:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
      },
      defaultDaemon: name,
    },
    {},
  );

  expect(parsed).toStrictEqual({ ok: false, errors: [error] });
});

test.each([
  [
    'a missing daemonID',
    { address: '100.64.0.2:8415' },
    "daemon 'cloud' needs the daemonID that atc daemon id prints on its host",
  ],
  [
    'a daemonID that is not a UUID',
    { address: '100.64.0.2:8415', daemonID: 'cloud' },
    "daemon 'cloud' needs the daemonID that atc daemon id prints on its host",
  ],
  [
    'an address without a port',
    { address: '100.64.0.2', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
    "daemon 'cloud' needs an address of <host>:<port> with a port from 1 to 65535",
  ],
  [
    'an entry that is not an object',
    'cloud',
    "daemon 'cloud' must be an object with address and daemonID",
  ],
])('it refuses a daemon with %s', (_label, entry, error) => {
  const parsed = parseGatewayRegistry(
    { daemons: { cloud: entry }, defaultDaemon: 'cloud' },
    { ATC_GATEWAY_TOKEN_CLOUD: 't' },
  );

  expect(parsed).toStrictEqual({ ok: false, errors: [error] });
});

test('it refuses a registry that lists no daemon', () => {
  const parsed = parseGatewayRegistry({ daemons: {}, defaultDaemon: 'cloud' }, {});

  expect(parsed).toStrictEqual({
    ok: false,
    errors: [
      'the registry lists no daemon',
      "defaultDaemon 'cloud' is not a daemon in the registry",
    ],
  });
});

test('it refuses a registry that is not an object', () => {
  expect(parseGatewayRegistry([], {})).toStrictEqual({
    ok: false,
    errors: ['the registry must be an object whose daemons is an object'],
  });
});

test('it takes a registry of 34 daemons with the longest names, whose worst-case events cursor still decodes', () => {
  const names = Array.from(
    { length: 34 },
    (_, i) => `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
  );

  const parsed = parseGatewayRegistry(
    {
      daemons: Object.fromEntries(
        names.map((name, i) => [
          name,
          {
            address: `100.64.0.${i + 1}:8415`,
            daemonID: `${String(i).padStart(8, 'f')}-0000-4000-8000-000000000000`,
          },
        ]),
      ),
      defaultDaemon: names[0],
    },
    Object.fromEntries(names.map((name) => [`ATC_GATEWAY_TOKEN_${name.toUpperCase()}`, 't'])),
  );

  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }

  const filter = buildEventsFilterHash('x'.repeat(200), null);
  const worst = encodeCursor({ kind: 'events', id: Number.MAX_SAFE_INTEGER });

  const cursor = encodeGatewayCursor(
    filter,
    new Map(
      [...parsed.registry.daemons.values()].map((d) => [`${d.name}.${d.incarnation}`, worst]),
    ),
  );

  expect(Buffer.byteLength(cursor)).toBeLessThanOrEqual(4096);
  expect(decodeGatewayCursor(cursor, filter, parsed.registry).size).toBe(34);
});

test('it refuses a registry of 35 daemons as over the limit of 34', () => {
  const names = Array.from(
    { length: 35 },
    (_, i) => `${'d'.repeat(29)}${String(i).padStart(2, '0')}`,
  );

  const parsed = parseGatewayRegistry(
    {
      daemons: Object.fromEntries(
        names.map((name, i) => [
          name,
          {
            address: `100.64.0.${i + 1}:8415`,
            daemonID: `${String(i).padStart(8, 'f')}-0000-4000-8000-000000000000`,
          },
        ]),
      ),
      defaultDaemon: names[0],
    },
    Object.fromEntries(names.map((name) => [`ATC_GATEWAY_TOKEN_${name.toUpperCase()}`, 't'])),
  );

  expect(parsed).toStrictEqual({
    ok: false,
    errors: [
      'the registry lists 35 daemons, over the limit of 34, the most whose events cursor fits 4096 bytes',
    ],
  });
});
