import { expect, test } from 'bun:test';
import { buildMockGatewayDescriptor } from './build-mock-gateway-descriptor';

test('it builds a descriptor with a gateway id and a locator that names its daemon', () => {
  const descriptor = buildMockGatewayDescriptor();

  expect([descriptor['id'], descriptor['locator']]).toStrictEqual([
    'build-box.k3f9.s7-m4x2p',
    { daemon: 'build-box', incarnation: 'k3f9', targetID: 'local' },
  ]);
});
