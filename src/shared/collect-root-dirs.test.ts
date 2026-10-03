import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectRootDirs } from './collect-root-dirs';

test('it lists each child directory of a root and the worktrees under it, sorted', () => {
  using temp = setupTempDir('atc-roots-');

  mkdirSync(join(temp.dir, 'zeta'));
  mkdirSync(join(temp.dir, 'atc', '.worktrees', 'fix-picker'), { recursive: true });
  mkdirSync(join(temp.dir, 'atc', '.worktrees', 'docs'), { recursive: true });
  writeFileSync(join(temp.dir, 'notes.txt'), '');

  expect(collectRootDirs([temp.dir])).toStrictEqual([
    join(temp.dir, 'atc'),
    join(temp.dir, 'atc', '.worktrees', 'docs'),
    join(temp.dir, 'atc', '.worktrees', 'fix-picker'),
    join(temp.dir, 'zeta'),
  ]);
});

test('it skips hidden directories under a root', () => {
  using temp = setupTempDir('atc-roots-');

  mkdirSync(join(temp.dir, '.cache'));
  mkdirSync(join(temp.dir, 'app'));

  expect(collectRootDirs([temp.dir])).toStrictEqual([join(temp.dir, 'app')]);
});

test('it contributes nothing for a root that does not exist', () => {
  using temp = setupTempDir('atc-roots-');

  expect(collectRootDirs([join(temp.dir, 'missing')])).toStrictEqual([]);
});
