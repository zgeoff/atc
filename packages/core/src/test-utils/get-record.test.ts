import { expect, test } from 'bun:test';
import { getRecord } from './get-record';

test('it returns an object field', () => {
  expect(getRecord({ session: { id: 's-1' } }, 'session')).toStrictEqual({ id: 's-1' });
});

test('it throws naming a field that holds another type', () => {
  expect(() => getRecord({ session: 's-1' }, 'session')).toThrowWithMessage(
    TypeError,
    'session is not an object',
  );
});

test('it throws naming a missing field', () => {
  expect(() => getRecord({}, 'session')).toThrowWithMessage(TypeError, 'session is not an object');
});
