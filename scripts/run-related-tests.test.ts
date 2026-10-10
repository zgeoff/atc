import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../src/test-utils/run-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { collectRelatedTests } from './run-related-tests';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('run-related-tests-');

  mkdirSync(join(tmp.dir, 'src'));

  return { dir: tmp.dir };
}

test('it selects a test file that exists', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/a.test.ts'), '');

  expect(collectRelatedTests(['src/a.test.ts'], ctx.dir)).toStrictEqual(['src/a.test.ts']);
});

test('it selects the sibling test of a source file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/a.ts'), '');
  writeFileSync(join(ctx.dir, 'src/a.test.ts'), '');

  expect(collectRelatedTests(['src/a.ts'], ctx.dir)).toStrictEqual(['src/a.test.ts']);
});

test('it skips a source file with no sibling test and a test file that was deleted', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/a.ts'), '');

  expect(collectRelatedTests(['src/a.ts', 'src/gone.test.ts'], ctx.dir)).toStrictEqual([]);
});

test('it skips a declaration file even when a test sits beside it', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/types.d.ts'), '');
  writeFileSync(join(ctx.dir, 'src/types.d.test.ts'), '');

  expect(collectRelatedTests(['src/types.d.ts'], ctx.dir)).toStrictEqual([]);
});

test('it skips files that are not TypeScript', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/a.md'), '');
  writeFileSync(join(ctx.dir, 'src/a.test.ts'), '');

  expect(collectRelatedTests(['src/a.md', 'README.md'], ctx.dir)).toStrictEqual([]);
});

test('it keeps the order of the paths and drops duplicates', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'src/b.ts'), '');
  writeFileSync(join(ctx.dir, 'src/b.test.ts'), '');
  writeFileSync(join(ctx.dir, 'src/a.test.ts'), '');

  expect(
    collectRelatedTests(['src/b.ts', 'src/a.test.ts', 'src/b.test.ts'], ctx.dir),
  ).toStrictEqual(['src/b.test.ts', 'src/a.test.ts']);
});

test('it exits 0 and says so when no path has a related test', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.ts'],
    { cwd: ctx.dir },
  );

  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('run-related-tests: no related tests\n');
});

test('it runs the related test through the test script and exits 0 when it passes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));

  writeFileSync(
    join(ctx.dir, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it adds', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  );

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.ts'],
    { cwd: ctx.dir },
  );

  expect(run.exitCode).toBe(0);
  expect(run.stderr).toInclude('1 pass');
});

test('it exits with the failing code when the related test fails', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));

  writeFileSync(
    join(ctx.dir, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it adds', () => {\n  expect(1 + 1).toBe(3);\n});\n",
  );

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.test.ts'],
    { cwd: ctx.dir },
  );

  expect(run.exitCode).toBe(1);
});
