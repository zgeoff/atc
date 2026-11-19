import { expect, test } from 'bun:test';
import { isClientBehind } from './is-client-behind';

test.each([
  ['a later', 8, true],
  ['an earlier', 6, false],
  ['the same', 7, false],
  ['no', null, false],
])('it answers %s daemon major with %p', (_label, daemonMajor, expected) => {
  expect(isClientBehind({ clientMajor: 7, daemonMajor })).toBe(expected);
});
