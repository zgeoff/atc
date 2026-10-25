import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import { readRelatedTests, runRelatedTests } from './run-related-tests';

// A temp directory standing in for a repo root.
function setupTest() {
  const temporaryDirectory = setupTempDir('run-related-tests-');

  mkdirSync(join(temporaryDirectory.path, 'src'));

  return { directory: temporaryDirectory.path };
}

test('it selects a test file that exists', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/a.test.ts'), '');

  expect(readRelatedTests(['src/a.test.ts'], ctx.directory)).toStrictEqual(['src/a.test.ts']);
});

test('it selects the sibling test of a source file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/a.ts'), '');
  writeFileSync(join(ctx.directory, 'src/a.test.ts'), '');

  expect(readRelatedTests(['src/a.ts'], ctx.directory)).toStrictEqual(['src/a.test.ts']);
});

test('it skips a source file with no sibling test and a test file that was deleted', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/a.ts'), '');

  expect(readRelatedTests(['src/a.ts', 'src/gone.test.ts'], ctx.directory)).toStrictEqual([]);
});

test('it skips a declaration file even when a test sits beside it', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/types.d.ts'), '');
  writeFileSync(join(ctx.directory, 'src/types.d.test.ts'), '');

  expect(readRelatedTests(['src/types.d.ts'], ctx.directory)).toStrictEqual([]);
});

test('it skips files that are not TypeScript', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/a.md'), '');
  writeFileSync(join(ctx.directory, 'src/a.test.ts'), '');

  expect(readRelatedTests(['src/a.md', 'README.md'], ctx.directory)).toStrictEqual([]);
});

test('it leaves out a lane suite, which the default run never runs', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/a.codex.test.ts'), '');

  expect(readRelatedTests(['src/a.codex.test.ts'], ctx.directory)).toStrictEqual([]);
});

test('it leaves out an e2e suite, which only the e2e lane runs', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'e2e'));
  writeFileSync(join(ctx.directory, 'e2e/tui-quit.test.ts'), '');

  expect(readRelatedTests(['e2e/tui-quit.test.ts'], ctx.directory)).toStrictEqual([]);
});

test('it keeps the order of the paths and drops duplicates', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'src/b.ts'), '');
  writeFileSync(join(ctx.directory, 'src/b.test.ts'), '');
  writeFileSync(join(ctx.directory, 'src/a.test.ts'), '');

  expect(
    readRelatedTests(['src/b.ts', 'src/a.test.ts', 'src/b.test.ts'], ctx.directory),
  ).toStrictEqual(['src/b.test.ts', 'src/a.test.ts']);
});

test('it exits 0 and says so when no path has a related test', async () => {
  const ctx = setupTest();

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.ts'],
    { cwd: ctx.directory },
  );

  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('run-related-tests: no related tests\n');
});

test('it runs the related test through the test script and exits 0 when it passes', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  );

  writeFileSync(
    join(ctx.directory, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it adds', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  );

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.ts'],
    { cwd: ctx.directory },
  );

  expect(run.exitCode).toBe(0);
  expect(run.stderr).toInclude('1 pass');
});

test('it exits with the failing code when the related test fails', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  );

  writeFileSync(
    join(ctx.directory, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it adds', () => {\n  expect(1 + 1).toBe(3);\n});\n",
  );

  const run = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-related-tests.ts'), 'src/a.test.ts'],
    { cwd: ctx.directory },
  );

  expect(run.exitCode).toBe(1);
});

test('it leaves out a listed test and runs the rest of its file', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  );

  writeFileSync(
    join(ctx.directory, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\n\ntest('it trims the hedge', () => {\n  expect(1 + 1).toBe(3);\n});\n\ntest('it rakes the leaves', () => {\n  writeFileSync('raked', '');\n});\n",
  );

  const exitCode = await runRelatedTests(
    ['src/a.test.ts'],
    ctx.directory,
    [{ file: 'src/a.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    1,
  );

  expect(exitCode).toBe(0);
  expect(existsSync(join(ctx.directory, 'raked'))).toBeTrue();
});

test('it runs a test whose name only starts with a listed name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  );

  writeFileSync(
    join(ctx.directory, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it trims the hedge twice', () => {\n  expect(1 + 1).toBe(3);\n});\n",
  );

  const exitCode = await runRelatedTests(
    ['src/a.test.ts'],
    ctx.directory,
    [{ file: 'src/a.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    1,
  );

  expect(exitCode).toBe(1);
});

test('it runs every planned run and returns the failure of an earlier one', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  );

  writeFileSync(
    join(ctx.directory, 'src/a.test.ts'),
    "import { expect, test } from 'bun:test';\n\ntest('it adds', () => {\n  expect(1 + 1).toBe(3);\n});\n",
  );

  writeFileSync(
    join(ctx.directory, 'src/b.test.ts'),
    "import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\n\ntest('it trims the hedge', () => {});\n\ntest('it rakes the leaves', () => {\n  writeFileSync('raked', '');\n});\n",
  );

  const exitCode = await runRelatedTests(
    ['src/a.test.ts', 'src/b.test.ts'],
    ctx.directory,
    [{ file: 'src/b.test.ts', test: 'it trims the hedge', issue: 'GEO-18' }],
    1,
  );

  expect(exitCode).toBe(1);
  expect(existsSync(join(ctx.directory, 'raked'))).toBeTrue();
});

test('it runs the test script with the worker count it is given', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo > args.txt' } }),
  );

  writeFileSync(join(ctx.directory, 'src/a.test.ts'), '');

  const exitCode = await runRelatedTests(['src/a.test.ts'], ctx.directory, [], 3);

  expect(exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'args.txt'), 'utf8')).toBe(
    'src/a.test.ts --parallel=3\n',
  );
});
