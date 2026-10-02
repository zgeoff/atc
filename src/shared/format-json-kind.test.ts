import { expect, test } from 'bun:test';
import { formatJSONKind } from './format-json-kind';

test.each([
  [null, 'null'],
  [[1], 'an array'],
  [{ token: 'x' }, 'an object'],
  ['x', 'a string'],
  [4, 'a number'],
  [true, 'a boolean'],
])('it formats %p as its kind without its value', (raw, kind) => {
  expect(formatJSONKind(raw)).toBe(kind);
});
