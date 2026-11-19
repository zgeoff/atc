import { expect, test } from 'bun:test';
import { parseJSONStrings } from './parse-json-strings';

test.each([
  ['["read","offline_access"]', ['read', 'offline_access']],
  ['["read",3,null]', ['read']],
  ['[]', []],
  ['{"read":true}', null],
  ['read', null],
])('it parses %p as %p', (raw, strings) => {
  expect(parseJSONStrings(raw)).toStrictEqual(strings);
});
