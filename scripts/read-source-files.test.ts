import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readSourceFiles } from './read-source-files';

// A temp directory standing in for a repo root.
function setupTest() {
  const temporaryDirectory = setupTempDir('collect-source-files-');

  return { directory: temporaryDirectory.path };
}

test('it lists source modules in sorted order, skipping installed packages and other files', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'packages/core/src/ids'), { recursive: true });
  mkdirSync(join(ctx.directory, 'packages/core/node_modules/zod'), { recursive: true });
  writeFileSync(join(ctx.directory, 'packages/core/src/ids/session-id.ts'), '');
  writeFileSync(join(ctx.directory, 'packages/core/src/clock.ts'), '');
  writeFileSync(join(ctx.directory, 'packages/core/src/notes.md'), '');
  writeFileSync(join(ctx.directory, 'packages/core/node_modules/zod/index.js'), '');
  writeFileSync(join(ctx.directory, 'packages/core/package.json'), '{}');

  expect(readSourceFiles(ctx.directory, 'packages')).toStrictEqual([
    'packages/core/src/clock.ts',
    'packages/core/src/ids/session-id.ts',
  ]);
});

test('it lists nothing for a directory that does not exist', () => {
  const ctx = setupTest();

  expect(readSourceFiles(ctx.directory, 'e2e')).toStrictEqual([]);
});
