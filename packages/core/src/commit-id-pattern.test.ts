import { expect, test } from 'bun:test';
import { COMMIT_ID_PATTERN } from './commit-id-pattern';

test.each([
  ['a SHA-1 commit id', 'a'.repeat(40), true],
  ['a SHA-256 commit id', 'b'.repeat(64), true],
  ['an abbreviated id', 'c'.repeat(12), false],
  ['an uppercase id', 'D'.repeat(40), false],
  ['a 41-digit id', 'e'.repeat(41), false],
])('it matches %s: %p', (_label, id, expected) => {
  expect(COMMIT_ID_PATTERN.test(id)).toBe(expected);
});
