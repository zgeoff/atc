import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { collectSourceFiles } from './collect-source-files';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('collect-source-files-');

  return { dir: tmp.dir };
}

test('it lists source modules in sorted order, skipping installed packages and other files', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'packages/core/src/ids'), { recursive: true });
  mkdirSync(join(ctx.dir, 'packages/core/node_modules/zod'), { recursive: true });
  writeFileSync(join(ctx.dir, 'packages/core/src/ids/session-id.ts'), '');
  writeFileSync(join(ctx.dir, 'packages/core/src/clock.ts'), '');
  writeFileSync(join(ctx.dir, 'packages/core/src/notes.md'), '');
  writeFileSync(join(ctx.dir, 'packages/core/node_modules/zod/index.js'), '');
  writeFileSync(join(ctx.dir, 'packages/core/package.json'), '{}');

  expect(collectSourceFiles(ctx.dir, 'packages')).toStrictEqual([
    'packages/core/src/clock.ts',
    'packages/core/src/ids/session-id.ts',
  ]);
});

test('it lists nothing for a directory that does not exist', () => {
  const ctx = setupTest();

  expect(collectSourceFiles(ctx.dir, 'e2e')).toStrictEqual([]);
});
