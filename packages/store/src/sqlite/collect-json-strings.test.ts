import { expect, test } from 'bun:test';
import { collectJSONStrings } from './collect-json-strings';

test.each([
  ['["read","offline_access"]', ['read', 'offline_access']],
  ['["read",3,null]', ['read']],
  ['{"read":true}', []],
  ['read', []],
])('it reads the strings in %p as %p', (raw, strings) => {
  expect(collectJSONStrings(raw)).toStrictEqual(strings);
});
