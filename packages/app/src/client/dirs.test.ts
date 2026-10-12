import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectDirs, findFuzzyScore, pickMatches } from './dirs';

function setupTest() {
  const tmp = setupTempDir('atc-dirs-');

  return { dir: tmp.dir };
}

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

  invariant(wordStart !== null && scattered !== null, 'both candidates should match');

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
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'cwd'));
  mkdirSync(join(ctx.dir, 'recent'));
  mkdirSync(join(ctx.dir, 'root', 'app'), { recursive: true });
  mkdirSync(join(ctx.dir, 'visited'));

  const dirs = collectDirs({
    cwd: join(ctx.dir, 'cwd'),
    recent: [join(ctx.dir, 'recent'), join(ctx.dir, 'cwd')],
    roots: [join(ctx.dir, 'root')],
    zoxide: [join(ctx.dir, 'visited'), join(ctx.dir, 'recent')],
  });

  expect(dirs).toStrictEqual([
    join(ctx.dir, 'cwd'),
    join(ctx.dir, 'recent'),
    join(ctx.dir, 'root', 'app'),
    join(ctx.dir, 'visited'),
  ]);
});

test('#collectDirs drops a directory that no longer exists', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'kept'));

  const dirs = collectDirs({
    cwd: join(ctx.dir, 'kept'),
    recent: [join(ctx.dir, 'gone')],
    roots: [],
    zoxide: [],
  });

  expect(dirs).toStrictEqual([join(ctx.dir, 'kept')]);
});

test('#collectDirs falls back to the home directory when every source is empty', () => {
  const ctx = setupTest();

  const dirs = collectDirs({
    cwd: join(ctx.dir, 'gone'),
    recent: [],
    roots: [],
    zoxide: [],
    home: join(ctx.dir, 'home'),
  });

  expect(dirs).toStrictEqual([join(ctx.dir, 'home')]);
});
