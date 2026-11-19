import { expect, test } from 'bun:test';
import { isRecord } from './is-record';

test.each([
  ['an object', { count: 1 }, true],
  ['an array', [1], true],
  ['null', null, false],
  ['a string', 'a', false],
  ['undefined', undefined, false],
])('it reads %s as a record: %p', (_label, value, expected) => {
  expect(isRecord(value)).toBe(expected);
});
