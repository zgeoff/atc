import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import type { TestSkip } from './load-test-skips';
import { loadTestSkips } from './load-test-skips';

// A temp directory to hold a skip list.
function setupTest() {
  const tmp = setupTempDir('load-test-skips-');

  return { dir: tmp.dir };
}

test('it loads each entry of a skip list', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([
      { file: 'e2e/tui-garden.test.ts', test: 'it waters the tulips', issue: 'GEO-17' },
      { file: 'src/hedge.test.ts', test: 'it trims the hedge', issue: 'GEO-18' },
    ]),
  );

  expect(loadTestSkips(path)).toStrictEqual([
    { file: 'e2e/tui-garden.test.ts', test: 'it waters the tulips', issue: 'GEO-17' },
    { file: 'src/hedge.test.ts', test: 'it trims the hedge', issue: 'GEO-18' },
  ]);
});

test('it loads an empty skip list', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(path, '[]');

  expect(loadTestSkips(path)).toStrictEqual([]);
});

test('it rejects an entry without a Linear issue ID', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([{ file: 'e2e/tui-garden.test.ts', test: 'it waters the tulips' }]),
  );

  expect(() => loadTestSkips(path)).toThrowWithMessage(Error, /issue/);
});

test('it rejects an issue that is not a Linear issue ID', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([
      { file: 'e2e/tui-garden.test.ts', test: 'it waters the tulips', issue: 'flaky' },
    ]),
  );

  expect(() => loadTestSkips(path)).toThrowWithMessage(Error, /must be a Linear issue ID/);
});

test('it rejects a file that is not a test file', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([{ file: 'src/hedge.ts', test: 'it trims the hedge', issue: 'GEO-18' }]),
  );

  expect(() => loadTestSkips(path)).toThrowWithMessage(Error, /must be a \.test\.ts path/);
});

test('it rejects an empty test name', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(path, JSON.stringify([{ file: 'src/hedge.test.ts', test: '', issue: 'GEO-18' }]));

  expect(() => loadTestSkips(path)).toThrowWithMessage(Error, /test/);
});

test('it rejects an entry with an unknown key', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([
      { file: 'src/hedge.test.ts', test: 'it trims the hedge', issue: 'GEO-18', until: 'spring' },
    ]),
  );

  expect(() => loadTestSkips(path)).toThrowWithMessage(Error, /until/);
});

test('it rejects the same test listed twice', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(
    path,
    JSON.stringify([
      { file: 'src/hedge.test.ts', test: 'it trims the hedge', issue: 'GEO-18' },
      { file: 'src/hedge.test.ts', test: 'it trims the hedge', issue: 'GEO-19' },
    ]),
  );

  expect(() => loadTestSkips(path)).toThrowWithMessage(
    Error,
    /"it trims the hedge" in src\/hedge\.test\.ts is listed twice/,
  );
});

test('it rejects a file that is not JSON', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'skips.json');

  writeFileSync(path, 'not json');

  expect(() => loadTestSkips(path)).toThrow(SyntaxError);
});

test('it loads the committed skip list, whose every entry points at a test file in the repo', () => {
  const repoRoot = join(import.meta.dir, '..');
  const skips = loadTestSkips(join(repoRoot, 'scripts/pre-push-test-skips.json'));

  expect(skips).toSatisfyAll((skip: TestSkip) => existsSync(join(repoRoot, skip.file)));
});
