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

test('it returns an empty string when the cap is zero', () => {
  expect(truncateToBytes('hello', 0)).toBe('');
});

test('it cuts to one byte without an ellipsis when the cap is one', () => {
  expect(truncateToBytes('hello', 1)).toBe('h');
});

test('it cuts to two bytes without an ellipsis when the cap is two', () => {
  expect(truncateToBytes('hello', 2)).toBe('he');
});

test('it backs off a split character when the cap is below the ellipsis length', () => {
  expect(truncateToBytes('é'.repeat(3), 1)).toBe('');
});
