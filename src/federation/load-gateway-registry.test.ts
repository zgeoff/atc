import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { loadGatewayRegistry } from './load-gateway-registry';

/**
 * A temp directory and `path`, a registry file path inside it that no test
 * has written yet.
 */
function setupTest() {
  const tmp = setupTempDir('atc-gateway-registry-');

  return { path: join(tmp.dir, 'registry.json'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it loads a registry file with its tokens from the environment', () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.path,
    JSON.stringify({
      daemons: {
        cloud: { address: '100.64.0.2:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const loaded = loadGatewayRegistry(ctx.path, { ATC_GATEWAY_TOKEN_CLOUD: 'cloud-token' });

  expect(loaded).toStrictEqual({
    ok: true,
    registry: {
      daemons: new Map([
        [
          'cloud',
          {
            name: 'cloud',
            address: { host: '100.64.0.2', port: 8415 },
            daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
            incarnation: '0f6c2a8e',
            token: 'cloud-token',
          },
        ],
      ]),
      defaultDaemon: 'cloud',
    },
  });
});

test('it refuses a registry file that is not JSON', () => {
  using ctx = setupTest();

  writeFileSync(ctx.path, '{ daemons');

  expect(loadGatewayRegistry(ctx.path, {})).toStrictEqual({
    ok: false,
    errors: [expect.toStartWith(`cannot read the registry at ${ctx.path}:`)],
  });
});

test('it refuses a registry file that does not exist', () => {
  using ctx = setupTest();

  expect(loadGatewayRegistry(ctx.path, {})).toStrictEqual({
    ok: false,
    errors: [expect.toStartWith(`cannot read the registry at ${ctx.path}:`)],
  });
});
