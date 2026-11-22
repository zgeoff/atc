import { expect, test } from 'bun:test';
import { toFoldedGraphemes } from './to-folded-graphemes';

test.each([
  { text: 'Web', expected: ['w', 'e', 'b'] },
  { text: 'ΟΔΟΣ', expected: ['ο', 'δ', 'ο', 'σ'] },
  { text: 'οδος', expected: ['ο', 'δ', 'ο', 'σ'] },
  { text: 'ß', expected: ['ss'] },
])('#toFoldedGraphemes folds each grapheme of $text alone', (row) => {
  expect(toFoldedGraphemes(row.text)).toStrictEqual([...row.expected]);
});
