import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectPathCompletions } from './collect-path-completions';

test('it lists every child directory after a trailing slash, the parent first', () => {
  using temp = setupTempDir('atc-complete-');

  mkdirSync(join(temp.dir, 'beta'));
  mkdirSync(join(temp.dir, 'alpha'));
  writeFileSync(join(temp.dir, 'readme.md'), '');

  expect(collectPathCompletions(`${temp.dir}/`, '/cwd', '/home/u')).toStrictEqual([
    temp.dir,
    join(temp.dir, 'alpha'),
    join(temp.dir, 'beta'),
  ]);
});

test('it narrows to children whose names start with the last segment, case-insensitively', () => {
  using temp = setupTempDir('atc-complete-');

  mkdirSync(join(temp.dir, 'Projects'));
  mkdirSync(join(temp.dir, 'prose'));
  mkdirSync(join(temp.dir, 'music'));

  expect(collectPathCompletions(`${temp.dir}/pr`, '/cwd', '/home/u')).toStrictEqual([
    join(temp.dir, 'Projects'),
    join(temp.dir, 'prose'),
  ]);
});

test('it puts an exact directory match ahead of the longer names it prefixes', () => {
  using temp = setupTempDir('atc-complete-');

  mkdirSync(join(temp.dir, 'atc-docs'));
  mkdirSync(join(temp.dir, 'atc'));

  expect(collectPathCompletions(`${temp.dir}/atc`, '/cwd', '/home/u')).toStrictEqual([
    join(temp.dir, 'atc'),
    join(temp.dir, 'atc-docs'),
  ]);
});

test('it shows hidden directories only when the segment starts with a dot', () => {
  using temp = setupTempDir('atc-complete-');

  mkdirSync(join(temp.dir, '.worktrees'));
  mkdirSync(join(temp.dir, 'src'));

  expect(collectPathCompletions(`${temp.dir}/`, '/cwd', '/home/u')).toStrictEqual([
    temp.dir,
    join(temp.dir, 'src'),
  ]);

  expect(collectPathCompletions(`${temp.dir}/.w`, '/cwd', '/home/u')).toStrictEqual([
    join(temp.dir, '.worktrees'),
  ]);
});

test('it completes a tilde path under the given home and a relative path under the cwd', () => {
  using temp = setupTempDir('atc-complete-');

  mkdirSync(join(temp.dir, 'home', 'projects'), { recursive: true });
  mkdirSync(join(temp.dir, 'cwd', 'api'), { recursive: true });

  expect(
    collectPathCompletions('~/pro', join(temp.dir, 'cwd'), join(temp.dir, 'home')),
  ).toStrictEqual([join(temp.dir, 'home', 'projects')]);

  expect(
    collectPathCompletions('./a', join(temp.dir, 'cwd'), join(temp.dir, 'home')),
  ).toStrictEqual([join(temp.dir, 'cwd', 'api')]);
});

test('it completes nothing for input that is not a path', () => {
  expect(collectPathCompletions('atc', '/cwd', '/home/u')).toStrictEqual([]);
});
