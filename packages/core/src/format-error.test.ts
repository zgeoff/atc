import { expect, test } from 'bun:test';
import { formatError } from './format-error';

test('it gives the message of an error', () => {
  expect(formatError(new Error('the orchard gate is locked'))).toBe('the orchard gate is locked');
});

test('it gives the text of a thrown value that is not an error', () => {
  expect(formatError('no pears today')).toBe('no pears today');
});
