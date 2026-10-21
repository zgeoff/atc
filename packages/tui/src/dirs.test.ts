import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { findFuzzyScore, pickMatches } from './dirs';

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
    ['/home/me/projects/vers/packages/api', '/home/me/projects/vers'],
    'vers',
  );

  expect(picked).toStrictEqual(['/home/me/projects/vers', '/home/me/projects/vers/packages/api']);
});

test('#pickMatches drops candidates the filter cannot fuzzy-match', () => {
  expect(pickMatches(['/home/me/projects/atc', '/home/me/music'], 'atc')).toStrictEqual([
    '/home/me/projects/atc',
  ]);
});
