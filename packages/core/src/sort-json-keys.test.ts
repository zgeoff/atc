import { expect, test } from 'bun:test';
import { sortJSONKeys } from './sort-json-keys';

test('it sorts keys at every depth by locale', () => {
  expect(
    JSON.stringify(
      sortJSONKeys(
        { banana: 1, apple: [{ Banana: 2, apple: 3 }], Cherry: { date: 4, cherry: 5 } },
        'locale',
      ),
    ),
  ).toBe('{"apple":[{"apple":3,"Banana":2}],"banana":1,"Cherry":{"cherry":5,"date":4}}');
});

test('it sorts keys at every depth by UTF-16 code unit', () => {
  expect(
    JSON.stringify(
      sortJSONKeys(
        { banana: 1, apple: [{ Banana: 2, apple: 3 }], Cherry: { date: 4, cherry: 5 } },
        'code-unit',
      ),
    ),
  ).toBe('{"Cherry":{"cherry":5,"date":4},"apple":[{"Banana":2,"apple":3}],"banana":1}');
});

test('it returns a value that is not an object or an array unchanged', () => {
  expect(sortJSONKeys('text', 'locale')).toBe('text');
});
