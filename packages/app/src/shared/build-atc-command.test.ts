import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildATCCommand } from './build-atc-command';

test('it runs the CLI entrypoint under bun ahead of the arguments from a source tree', () => {
  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));

  expect(buildATCCommand(['daemon', 'restart'], false)).toStrictEqual([
    process.execPath,
    join(repoRoot, 'src/cli.ts'),
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
  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));

  expect(buildATCCommand(['daemon'])).toStrictEqual([
    process.execPath,
    join(repoRoot, 'src/cli.ts'),
    'daemon',
  ]);
});
