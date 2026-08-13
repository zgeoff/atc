import { expect, test } from 'bun:test';
import { findFuzzyScore, pickMatches } from './dirs';

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
