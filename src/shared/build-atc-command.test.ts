import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildATCCommand } from './build-atc-command';

test('it runs the CLI entrypoint under bun ahead of the arguments from a source tree', () => {
  expect(buildATCCommand(['daemon', 'restart'])).toStrictEqual([
    process.execPath,
    join(import.meta.dir, '..', 'cli.ts'),
    'daemon',
    'restart',
  ]);
});
