import { expect, test } from 'bun:test';
import { splitGraphemes } from './split-graphemes';

test('#splitGraphemes keeps a combined grapheme in one piece', () => {
  expect(splitGraphemes('é界')).toStrictEqual([
    { text: 'é', width: 1 },
    { text: '界', width: 2 },
  ]);
});
