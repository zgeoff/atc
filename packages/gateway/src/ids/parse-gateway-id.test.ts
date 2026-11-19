import { expect, test } from 'bun:test';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { parseGatewayID } from './parse-gateway-id';

test('it routes a gateway id back to its daemon and the daemon id inside it', () => {
  const cloud = buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' });

  const parsed = parseGatewayID('cloud.0f6c2a8e.m-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c', {
    daemons: new Map([['cloud', cloud]]),
    defaultDaemon: 'cloud',
  });

  expect(parsed).toStrictEqual({ daemon: cloud, id: 'm-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c' });
});

test.each([
  ['cloud.11111111.s7-m4x2p', 'a stale incarnation'],
  ['pc.0f6c2a8e.s7-m4x2p', 'an unknown daemon name'],
  ['s7-m4x2p', 'a daemon id with no parts'],
  ['cloud.0f6c2a8e.', 'an empty daemon id'],
  ['cloud.s7-m4x2p', 'a missing incarnation'],
  ['', 'an empty string'],
])('it routes %p nowhere as %s', (value) => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(parseGatewayID(value, registry)).toBeNull();
});
