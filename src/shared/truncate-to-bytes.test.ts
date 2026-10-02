import { expect, test } from 'bun:test';
import { truncateToBytes } from './truncate-to-bytes';

test('it returns text within the byte limit unchanged', () => {
  expect(truncateToBytes('hello', 5)).toBe('hello');
});

test('it cuts text past the byte limit and marks the cut with an ellipsis', () => {
  expect(truncateToBytes('a'.repeat(20), 10)).toBe(`${'a'.repeat(7)}…`);
});

test('it never splits a multi-byte character at the cut', () => {
  const result = truncateToBytes('é'.repeat(10), 10);

  expect(result).toBe(`${'é'.repeat(3)}…`);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10);
});
