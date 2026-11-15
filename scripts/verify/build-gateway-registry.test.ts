import { expect, test } from 'bun:test';
import { buildGatewayRegistry } from './build-gateway-registry.ts';

test("it lists the run's daemon at its loopback port as the default daemon", () => {
  expect(buildGatewayRegistry(41_877, '0123abcd-0000-4000-8000-000000000000')).toStrictEqual({
    daemons: {
      verify: { address: '127.0.0.1:41877', daemonID: '0123abcd-0000-4000-8000-000000000000' },
    },
    defaultDaemon: 'verify',
  });
});
