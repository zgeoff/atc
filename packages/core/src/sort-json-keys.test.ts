import { expect, test } from 'bun:test';
import { sortJSONKeys } from './sort-json-keys';

test('it sorts keys at every depth by locale', () => {
  expect(
    JSON.stringify(sortJSONKeys({ b: 1, a: [{ B: 2, a: 3 }], C: { d: 4, c: 5 } }, 'locale')),
  ).toBe('{"a":[{"a":3,"B":2}],"b":1,"C":{"c":5,"d":4}}');
});

test('it sorts keys at every depth by UTF-16 code unit', () => {
  expect(
    JSON.stringify(sortJSONKeys({ b: 1, a: [{ B: 2, a: 3 }], C: { d: 4, c: 5 } }, 'code-unit')),
  ).toBe('{"C":{"c":5,"d":4},"a":[{"B":2,"a":3}],"b":1}');
});

test('it returns a value that is not an object or an array unchanged', () => {
  expect(sortJSONKeys('text', 'locale')).toBe('text');
});
