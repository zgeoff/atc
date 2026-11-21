import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { run } from '@zgeoff/testing/process';

test.each([
  ['no out folder', []],
  ['an out folder given as a positional', ['tarballs']],
  ['a second positional', ['--out', 'tarballs', 'repo', 'extra']],
])('it refuses %s with its usage', async (_label, args) => {
  const packed = await run([process.execPath, join(import.meta.dir, 'pack-contract.ts'), ...args]);

  expect(packed.exitCode).toBe(1);
  expect(packed.stderr).toInclude('usage: bun scripts/pack-contract.ts --out <dir> [root]');
});

test('it refuses an option it does not know', async () => {
  const packed = await run([
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
