import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectDirs, findFuzzyScore, pickMatches } from './dirs';

test('it matches filter characters in order anywhere in the candidate', () => {
  expect(findFuzzyScore('vers', 'vrs')).not.toBeNull();
  expect(findFuzzyScore('atc-worktree', 'atcw')).not.toBeNull();
  expect(findFuzzyScore('projects', 'pjs')).not.toBeNull();
});

test('it misses when a filter character never appears after the previous hit', () => {
  expect(findFuzzyScore('vers', 'vx')).toBeNull();
  expect(findFuzzyScore('abc', 'cba')).toBeNull();
});

test('it scores word-start and consecutive hits above scattered ones', () => {
  const wordStart = findFuzzyScore('music-bot', 'mb');
  const scattered = findFuzzyScore('maberry', 'mb');

  if (wordStart === null || scattered === null) {
    throw new Error('both candidates should match');
  }

  expect(wordStart).toBeGreaterThan(scattered);
});

test('it ranks basename matches above path-only matches', () => {
  const picked = pickMatches(
    ['/home/geoff/projects/vers/packages/api', '/home/geoff/projects/vers'],
    'vers',
  );

  expect(picked[0]).toBe('/home/geoff/projects/vers');
});

test('it drops candidates the filter cannot fuzzy-match', () => {
  expect(pickMatches(['/home/geoff/projects/atc', '/home/geoff/music'], 'atc')).toStrictEqual([
    '/home/geoff/projects/atc',
  ]);
});

test('it lists the working directory first, then history, roots, and zoxide, without repeats', () => {
  using temp = setupTempDir('atc-dirs-');

  mkdirSync(join(temp.dir, 'cwd'));
  mkdirSync(join(temp.dir, 'recent'));
  mkdirSync(join(temp.dir, 'root', 'app'), { recursive: true });
  mkdirSync(join(temp.dir, 'visited'));

  const dirs = collectDirs({
    cwd: join(temp.dir, 'cwd'),
    recent: [join(temp.dir, 'recent'), join(temp.dir, 'cwd')],
    roots: [join(temp.dir, 'root')],
    zoxide: [join(temp.dir, 'visited'), join(temp.dir, 'recent')],
  });

  expect(dirs).toStrictEqual([
    join(temp.dir, 'cwd'),
    join(temp.dir, 'recent'),
    join(temp.dir, 'root', 'app'),
    join(temp.dir, 'visited'),
  ]);
});

test('it drops a directory that no longer exists', () => {
  using temp = setupTempDir('atc-dirs-');

  mkdirSync(join(temp.dir, 'kept'));

  const dirs = collectDirs({
    cwd: join(temp.dir, 'kept'),
    recent: [join(temp.dir, 'gone')],
    roots: [],
    zoxide: [],
  });

  expect(dirs).toStrictEqual([join(temp.dir, 'kept')]);
});

test('it falls back to the home directory when every source is empty', () => {
  using temp = setupTempDir('atc-dirs-');

  const dirs = collectDirs({ cwd: join(temp.dir, 'gone'), recent: [], roots: [], zoxide: [] });

  expect(dirs).toStrictEqual([homedir()]);
});
