import { expect, test } from 'bun:test';
import { findUnsuccessfulResult } from './find-unsuccessful-result';

test.each([
  ['success success', null],
  ['success skipped', 'skipped'],
  ['failure success', 'failure'],
  ['success cancelled', 'cancelled'],
  ['', null],
])('it finds the first result other than success in %p: %p', (results, expected) => {
  expect(findUnsuccessfulResult(results)).toBe(expected);
});
