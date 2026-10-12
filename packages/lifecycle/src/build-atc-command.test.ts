import { expect, test } from 'bun:test';
import { buildATCCommand } from './build-atc-command';

test('it puts the arguments after the argv that starts a source tree', () => {
  expect(
    buildATCCommand(['/usr/bin/bun', '/src/atc/packages/app/src/cli.ts'], ['daemon', 'restart']),
  ).toStrictEqual(['/usr/bin/bun', '/src/atc/packages/app/src/cli.ts', 'daemon', 'restart']);
});

test('it puts the arguments after a compiled binary', () => {
  expect(buildATCCommand(['/home/me/.local/bin/atc'], ['daemon'])).toStrictEqual([
    '/home/me/.local/bin/atc',
    'daemon',
  ]);
});
