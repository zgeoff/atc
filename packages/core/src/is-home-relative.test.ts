import { expect, test } from 'bun:test';
import { isHomeRelative } from './is-home-relative';

test.each([
  ['~', true],
  ['~/src', true],
  ['~bob/src', false],
  ['/home/a', false],
  ['src/~', false],
])('it reads %s as home-relative: %p', (path, expected) => {
  expect(isHomeRelative(path)).toBe(expected);
});
