import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readPathCompletions } from './read-path-completions';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-complete-');

  return { directory: temporaryDirectory.path };
}

test('it lists every child directory after a trailing slash, the parent first', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'beta'));
  mkdirSync(join(ctx.directory, 'alpha'));
  writeFileSync(join(ctx.directory, 'readme.md'), '');

  expect(readPathCompletions(`${ctx.directory}/`, '/cwd', '/home/u')).toStrictEqual([
    ctx.directory,
    join(ctx.directory, 'alpha'),
    join(ctx.directory, 'beta'),
  ]);
});

test('it narrows to children whose names start with the last segment, case-insensitively', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'Projects'));
  mkdirSync(join(ctx.directory, 'prose'));
  mkdirSync(join(ctx.directory, 'music'));

  expect(readPathCompletions(`${ctx.directory}/pr`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.directory, 'Projects'),
    join(ctx.directory, 'prose'),
  ]);
});

test('it puts an exact directory match ahead of the longer names it prefixes', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'atc-docs'));
  mkdirSync(join(ctx.directory, 'atc'));

  expect(readPathCompletions(`${ctx.directory}/atc`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.directory, 'atc'),
    join(ctx.directory, 'atc-docs'),
  ]);
});

test('it leaves hidden directories out when the segment does not start with a dot', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.worktrees'));
  mkdirSync(join(ctx.directory, 'src'));

  expect(readPathCompletions(`${ctx.directory}/`, '/cwd', '/home/u')).toStrictEqual([
    ctx.directory,
    join(ctx.directory, 'src'),
  ]);
});

test('it shows hidden directories when the segment starts with a dot', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.worktrees'));
  mkdirSync(join(ctx.directory, 'src'));

  expect(readPathCompletions(`${ctx.directory}/.w`, '/cwd', '/home/u')).toStrictEqual([
    join(ctx.directory, '.worktrees'),
  ]);
});

test('it completes a tilde path under the given home', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'home', 'projects'), { recursive: true });
  mkdirSync(join(ctx.directory, 'cwd', 'projects'), { recursive: true });

  expect(
    readPathCompletions('~/pro', join(ctx.directory, 'cwd'), join(ctx.directory, 'home')),
  ).toStrictEqual([join(ctx.directory, 'home', 'projects')]);
});

test('it completes a relative path under the given working directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'home', 'api'), { recursive: true });
  mkdirSync(join(ctx.directory, 'cwd', 'api'), { recursive: true });

  expect(
    readPathCompletions('./a', join(ctx.directory, 'cwd'), join(ctx.directory, 'home')),
  ).toStrictEqual([join(ctx.directory, 'cwd', 'api')]);
});

test('it completes nothing for input that is not a path', () => {
  expect(readPathCompletions('atc', '/cwd', '/home/u')).toStrictEqual([]);
});
