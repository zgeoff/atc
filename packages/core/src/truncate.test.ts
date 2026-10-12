import { expect, test } from 'bun:test';
import { truncate } from './truncate';

test('it keeps text at the cap as it is', () => {
  expect(truncate('abcde', 5)).toBe('abcde');
});

test('it ends text past the cap with an ellipsis inside the cap', () => {
  expect(truncate('abcdef', 5)).toBe('abcd…');
});

test('it keeps newlines unless asked to flatten', () => {
  expect(truncate('a\nb', 5)).toBe('a\nb');
});

test('it turns each newline into a space when asked to flatten', () => {
  expect(truncate('a\nb\nc', 5, { flatten: true })).toBe('a b c');
});
