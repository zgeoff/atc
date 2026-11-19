import { expect, test } from 'bun:test';
import { getSettledValue } from './get-settled-value';

test('it returns the value of a fulfilled result', () => {
  expect(getSettledValue({ status: 'fulfilled', value: 'imp-a' })).toBe('imp-a');
});

test('it throws the reason of a rejected result', () => {
  const reason = new Error('impd did not answer');

  expect(() => getSettledValue({ status: 'rejected', reason })).toThrow(reason);
});
