import { expect, test } from 'bun:test';
import { getRecords } from './get-records';

test('it returns an array of records', () => {
  expect(getRecords({ sessions: [{ id: 's-1' }, { id: 's-2' }] }, 'sessions')).toStrictEqual([
    { id: 's-1' },
    { id: 's-2' },
  ]);
});

test('it returns an empty array', () => {
  expect(getRecords({ sessions: [] }, 'sessions')).toStrictEqual([]);
});

test('it throws naming a field that is not an array', () => {
  expect(() => getRecords({ sessions: {} }, 'sessions')).toThrowWithMessage(
    TypeError,
    'sessions is not an array of records',
  );
});

test('it throws naming an array that holds something other than records', () => {
  expect(() => getRecords({ sessions: [{ id: 's-1' }, 's-2'] }, 'sessions')).toThrowWithMessage(
    TypeError,
    'sessions is not an array of records',
  );
});
