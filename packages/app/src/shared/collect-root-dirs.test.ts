import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectRootDirs } from './collect-root-dirs';

function setupTest() {
  const tmp = setupTempDir('atc-roots-');

  return { dir: tmp.dir };
}

test('it lists each child directory of a root and the worktrees under it, sorted', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'zeta'));
  mkdirSync(join(ctx.dir, 'atc', '.worktrees', 'fix-picker'), { recursive: true });
  mkdirSync(join(ctx.dir, 'atc', '.worktrees', 'docs'), { recursive: true });
  writeFileSync(join(ctx.dir, 'notes.txt'), '');

  expect(collectRootDirs([ctx.dir])).toStrictEqual([
    join(ctx.dir, 'atc'),
    join(ctx.dir, 'atc', '.worktrees', 'docs'),
    join(ctx.dir, 'atc', '.worktrees', 'fix-picker'),
    join(ctx.dir, 'zeta'),
  ]);
});

test('it skips hidden directories under a root', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '.cache'));
  mkdirSync(join(ctx.dir, 'app'));

  expect(collectRootDirs([ctx.dir])).toStrictEqual([join(ctx.dir, 'app')]);
});

test('it contributes nothing for a root that does not exist', () => {
  const ctx = setupTest();

  expect(collectRootDirs([join(ctx.dir, 'missing')])).toStrictEqual([]);
});
