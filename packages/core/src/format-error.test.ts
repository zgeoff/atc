import { expect, test } from 'bun:test';
import { formatError } from './format-error';

test('it formats an error as its message', () => {
  expect(formatError(new Error('the disk is full'))).toBe('the disk is full');
});

test('it formats a thrown value that is no error as its text', () => {
  expect(formatError('the disk is full')).toBe('the disk is full');
});
