import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGatewayCommand } from './resolve-gateway-command';

test('it runs the source entry under the running bun without a binary', () => {
  const appRoot = dirname(fileURLToPath(import.meta.resolve('../../app/package.json')));

  expect(resolveGatewayCommand(undefined)).toStrictEqual([
    process.execPath,
    join(appRoot, 'src/gateway.ts'),
  ]);
});

test('it runs the binary alone when one is given', () => {
  expect(resolveGatewayCommand('/opt/atc-gateway-linux-x64')).toStrictEqual([
    '/opt/atc-gateway-linux-x64',
  ]);
});
