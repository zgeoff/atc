import { expect, test } from 'bun:test';
import { getString } from './get-string';

test('it returns a string field', () => {
  expect(getString({ id: 's-1' }, 'id')).toBe('s-1');
});

test('it throws naming a field that holds another type', () => {
  expect(() => getString({ id: 7 }, 'id')).toThrowWithMessage(TypeError, 'id is not a string');
});

test('it throws naming a missing field', () => {
  expect(() => getString({}, 'id')).toThrowWithMessage(TypeError, 'id is not a string');
});
