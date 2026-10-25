import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils';

test.each([
  ['no out folder', []],
  ['an out folder given as a positional', ['tarballs']],
  ['a second positional', ['--out', 'tarballs', 'repo', 'extra']],
])('it refuses %s with its usage', async (_label, args) => {
  const packed = await runCommand([
    process.execPath,
    join(import.meta.dir, 'pack-contract.ts'),
    ...args,
  ]);

  expect(packed.exitCode).toBe(1);
  expect(packed.stderr).toInclude('usage: bun scripts/pack-contract.ts --out <dir> [root]');
});

test('it refuses an option it does not know', async () => {
  const packed = await runCommand([
    process.execPath,
    join(import.meta.dir, 'pack-contract.ts'),
    '--out',
    'tarballs',
    '--tag',
    'next',
  ]);

  expect(packed.exitCode).toBe(1);
  expect(packed.stderr).toInclude("Unknown option '--tag'");
});
