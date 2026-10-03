import { expect, test } from 'bun:test';
import { buildGatewayID } from './build-gateway-id';
import { parseGatewayID } from './parse-gateway-id';

test('it routes a gateway id back to its daemon and the daemon id inside it', () => {
  const cloud = {
    name: 'cloud',
    address: { host: '100.64.0.2', port: 8415 },
    daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
    incarnation: '0f6c2a8e',
    token: 't',
  };

  const registry = { daemons: new Map([['cloud', cloud]]), defaultDaemon: 'cloud' };
  const id = buildGatewayID(cloud, 'm-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c');

  expect(id).toBe('cloud.0f6c2a8e.m-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c');

  expect(parseGatewayID(id, registry)).toStrictEqual({
    daemon: cloud,
    id: 'm-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
  });
});

test.each([
  ['a stale incarnation', 'cloud.11111111.s7-m4x2p'],
  ['an unknown daemon name', 'pc.0f6c2a8e.s7-m4x2p'],
  ['a daemon id with no parts', 's7-m4x2p'],
  ['an empty daemon id', 'cloud.0f6c2a8e.'],
  ['a missing incarnation', 'cloud.s7-m4x2p'],
  ['an empty string', ''],
])('it routes nowhere for %s', (_label, value) => {
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

  expect(parseGatewayID(value, registry)).toBeNull();
});
