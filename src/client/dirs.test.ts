import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectDirs, findFuzzyScore, pickMatches } from './dirs';

test.each([
  ['vers', 'vrs'],
  ['atc-worktree', 'atcw'],
  ['projects', 'pjs'],
])('#findFuzzyScore matches %p by the filter %p, its characters in order', (candidate, filter) => {
  expect(findFuzzyScore(candidate, filter)).toBeNumber();
});

test.each([
  ['vers', 'vx'],
  ['abc', 'cba'],
])(
  '#findFuzzyScore misses %p by the filter %p, a character never following the previous hit',
  (candidate, filter) => {
    expect(findFuzzyScore(candidate, filter)).toBeNull();
  },
);

test('#findFuzzyScore scores word-start and consecutive hits above scattered ones', () => {
  const wordStart = findFuzzyScore('music-bot', 'mb');
  const scattered = findFuzzyScore('maberry', 'mb');

  if (wordStart === null || scattered === null) {
    throw new Error('both candidates should match');
  }

  expect(wordStart).toBeGreaterThan(scattered);
});

test('#pickMatches ranks basename matches above path-only matches', () => {
  const picked = pickMatches(
    ['/home/geoff/projects/vers/packages/api', '/home/geoff/projects/vers'],
    'vers',
  );

  expect(picked).toStrictEqual([
    '/home/geoff/projects/vers',
    '/home/geoff/projects/vers/packages/api',
  ]);
});

test('#pickMatches drops candidates the filter cannot fuzzy-match', () => {
  expect(pickMatches(['/home/geoff/projects/atc', '/home/geoff/music'], 'atc')).toStrictEqual([
    '/home/geoff/projects/atc',
  ]);
});

test('#collectDirs lists the working directory first, then history, roots, and zoxide, without repeats', () => {
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

test('#collectDirs drops a directory that no longer exists', () => {
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

test('#collectDirs falls back to the home directory when every source is empty', () => {
  using temp = setupTempDir('atc-dirs-');

  const dirs = collectDirs({ cwd: join(temp.dir, 'gone'), recent: [], roots: [], zoxide: [] });

  expect(dirs).toStrictEqual([resolveHomeDir()]);
});
