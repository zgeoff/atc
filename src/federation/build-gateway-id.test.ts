import { expect, test } from 'bun:test';
import { buildGatewayID } from './build-gateway-id';

test('it qualifies a daemon id with the daemon name and incarnation', () => {
  expect(
    buildGatewayID(
      { name: 'cloud', incarnation: '0f6c2a8e' },
      'm-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
    ),
  ).toBe('cloud.0f6c2a8e.m-2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c');
});
