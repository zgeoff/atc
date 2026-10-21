import { expect, test } from 'bun:test';
import { isClientBehind } from './is-client-behind';

test.each([
  ['a later', 5, true],
  ['an earlier', 3, false],
  ['no', null, false],
])('it answers %s daemon protocol with %p', (_label, daemonProtocol, expected) => {
  expect(isClientBehind({ clientProtocol: 4, daemonProtocol })).toBe(expected);
});
