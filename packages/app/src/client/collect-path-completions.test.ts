import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectPathCompletions } from './collect-path-completions';

function setupTest() {
  const tmp = setupTempDir('atc-complete-');

  return { dir: tmp.dir };
}

test('it lists every child directory after a trailing slash, the parent first', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'beta'));
  mkdirSync(join(ctx.dir, 'alpha'));
  writeFileSync(join(ctx.dir, 'readme.md'), '');

  expect(collectPathCompletions(`${ctx.dir}/`, '/cwd', '/home/u')).toStrictEqual([
    ctx.dir,
    join(ctx.dir, 'alpha'),
    join(ctx.dir, 'beta'),
  ]);
});

test('it narrows to children whose names start with the last segment, case-insensitively', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'Projects'));
  mkdirSync(join(ctx.dir, 'prose'));
  mkdirSync(join(ctx.dir, 'music'));

  expect(collectPathCompletions(`${ctx.dir}/pr`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.dir, 'Projects'),
    join(ctx.dir, 'prose'),
  ]);
});

test('it puts an exact directory match ahead of the longer names it prefixes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'atc-docs'));
  mkdirSync(join(ctx.dir, 'atc'));

  expect(collectPathCompletions(`${ctx.dir}/atc`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.dir, 'atc'),
    join(ctx.dir, 'atc-docs'),
  ]);
});

test('it leaves hidden directories out when the segment does not start with a dot', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '.worktrees'));
  mkdirSync(join(ctx.dir, 'src'));

  expect(collectPathCompletions(`${ctx.dir}/`, '/cwd', '/home/u')).toStrictEqual([
    ctx.dir,
    join(ctx.dir, 'src'),
  ]);
});

test('it shows hidden directories when the segment starts with a dot', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '.worktrees'));
  mkdirSync(join(ctx.dir, 'src'));

  expect(collectPathCompletions(`${ctx.dir}/.w`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.dir, '.worktrees'),
  ]);
});

test('it completes a tilde path under the given home', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'home', 'projects'), { recursive: true });
  mkdirSync(join(ctx.dir, 'cwd', 'projects'), { recursive: true });

  expect(
    collectPathCompletions('~/pro', join(ctx.dir, 'cwd'), join(ctx.dir, 'home')),
  ).toStrictEqual([join(ctx.dir, 'home', 'projects')]);
});

test('it completes a relative path under the given working directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'home', 'api'), { recursive: true });
  mkdirSync(join(ctx.dir, 'cwd', 'api'), { recursive: true });

  expect(collectPathCompletions('./a', join(ctx.dir, 'cwd'), join(ctx.dir, 'home'))).toStrictEqual([
    join(ctx.dir, 'cwd', 'api'),
  ]);
});

test('it completes nothing for input that is not a path', () => {
  expect(collectPathCompletions('atc', '/cwd', '/home/u')).toStrictEqual([]);
});
