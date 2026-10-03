import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { loadGatewayRegistry } from './load-gateway-registry';

test('it loads a registry file with its tokens from the environment', () => {
  using tmp = setupTempDir('atc-gateway-registry-');

  const path = join(tmp.dir, 'registry.json');

  writeFileSync(
    path,
    JSON.stringify({
      daemons: {
        cloud: { address: '100.64.0.2:8415', daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const loaded = loadGatewayRegistry(path, { ATC_GATEWAY_TOKEN_CLOUD: 'cloud-token' });

  expect(loaded).toMatchObject({ ok: true, registry: { defaultDaemon: 'cloud' } });
});

test('it refuses a registry file that is not JSON', () => {
  using tmp = setupTempDir('atc-gateway-registry-');

  const path = join(tmp.dir, 'registry.json');

  writeFileSync(path, '{ daemons');

  expect(loadGatewayRegistry(path, {})).toStrictEqual({
    ok: false,
    errors: [expect.toStartWith(`cannot read the registry at ${path}:`)],
  });
});

test('it refuses a registry file that does not exist', () => {
  using tmp = setupTempDir('atc-gateway-registry-');

  const path = join(tmp.dir, 'missing.json');

  expect(loadGatewayRegistry(path, {})).toStrictEqual({
    ok: false,
    errors: [expect.toStartWith(`cannot read the registry at ${path}:`)],
  });
});
