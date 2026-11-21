import { expect, test } from 'bun:test';
import { readTypedCharacter } from './read-typed-character';

test.each([
  { title: 'a letter', bytes: 'a', expected: 'a' },
  { title: 'a wide character', bytes: '界', expected: '界' },
  { title: 'null for the escape key', bytes: '\u001B', expected: null },
  { title: 'null for an arrow key', bytes: '\u001B[A', expected: null },
  { title: 'null for backspace', bytes: '\u007F', expected: null },
  { title: 'null for a paste of two characters', bytes: 'ab', expected: null },
])('#readTypedCharacter gives $title', (row) => {
  expect(readTypedCharacter(Buffer.from(row.bytes))).toBe(row.expected);
});
