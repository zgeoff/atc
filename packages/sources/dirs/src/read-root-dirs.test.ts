import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readRootDirs } from './read-root-dirs';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-roots-');

  return { directory: temporaryDirectory.path };
}

test('it lists each child directory of a root and the worktrees under it, sorted', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'zeta'));
  mkdirSync(join(ctx.directory, 'atc', '.worktrees', 'fix-picker'), { recursive: true });
  mkdirSync(join(ctx.directory, 'atc', '.worktrees', 'docs'), { recursive: true });
  writeFileSync(join(ctx.directory, 'notes.txt'), '');

  expect(readRootDirs([ctx.directory])).toStrictEqual([
    join(ctx.directory, 'atc'),
    join(ctx.directory, 'atc', '.worktrees', 'docs'),
    join(ctx.directory, 'atc', '.worktrees', 'fix-picker'),
    join(ctx.directory, 'zeta'),
  ]);
});

test('it skips hidden directories under a root', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.cache'));
  mkdirSync(join(ctx.directory, 'app'));

  expect(readRootDirs([ctx.directory])).toStrictEqual([join(ctx.directory, 'app')]);
});

test('it contributes nothing for a root that does not exist', () => {
  const ctx = setupTest();

  expect(readRootDirs([join(ctx.directory, 'missing')])).toStrictEqual([]);
});
