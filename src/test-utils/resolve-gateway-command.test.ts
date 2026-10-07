import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveGatewayCommand } from './resolve-gateway-command';

test('it runs the source entry under the running bun without a binary', () => {
  expect(resolveGatewayCommand(undefined)).toStrictEqual([
    process.execPath,
    join(import.meta.dir, '..', 'gateway.ts'),
  ]);
});

test('it runs the binary alone when one is given', () => {
  expect(resolveGatewayCommand('/opt/atc-gateway-linux-x64')).toStrictEqual([
    '/opt/atc-gateway-linux-x64',
  ]);
});
