import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildATCCommand } from './build-atc-command';

test('it runs the CLI entrypoint under bun ahead of the arguments from a source tree', () => {
  expect(buildATCCommand(['daemon', 'restart'], false)).toStrictEqual([
    process.execPath,
    join(import.meta.dir, '..', 'cli.ts'),
    'daemon',
    'restart',
  ]);
});

test('it runs the compiled binary itself ahead of the arguments', () => {
  expect(buildATCCommand(['daemon', 'restart'], true)).toStrictEqual([
    process.execPath,
    'daemon',
    'restart',
  ]);
});

test('it reads a bun process as a source tree when the caller does not say', () => {
  expect(buildATCCommand(['daemon'])).toStrictEqual([
    process.execPath,
    join(import.meta.dir, '..', 'cli.ts'),
    'daemon',
  ]);
});
