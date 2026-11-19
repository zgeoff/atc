import { expect, test } from 'bun:test';
import { splitToWidth } from './split-to-width';

test('it keeps text that fits in one row', () => {
  expect(splitToWidth('cloned commit 0123456789ab', 40)).toStrictEqual([
    'cloned commit 0123456789ab',
  ]);
});

test('it breaks text at the last space that fits each row', () => {
  expect(
    splitToWidth('left 2 paths in /src/app behind; cloned commit 0123456789ab', 24),
  ).toStrictEqual(['left 2 paths in /src/app', 'behind; cloned commit', '0123456789ab']);
});

test('it breaks a word wider than a row at the row edge', () => {
  expect(splitToWidth('in /home/me/src/app behind', 8)).toStrictEqual([
    'in',
    '/home/me',
    '/src/app',
    'behind',
  ]);
});

test('it breaks a word at a code point boundary, never inside a character', () => {
  expect(splitToWidth('/ab😀cd', 4)).toStrictEqual(['/ab😀', 'cd']);
});

test('it returns the text whole when no row has room', () => {
  expect(splitToWidth('behind', 0)).toStrictEqual(['behind']);
});
