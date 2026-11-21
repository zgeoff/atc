import { expect, test } from 'bun:test';
import { splitReplayChunks } from './split-replay-chunks';

test.each<{ name: string; replay: string; maxLength: number; expected: string[] }>([
  { name: 'an empty replay as one empty chunk', replay: '', maxLength: 4, expected: [''] },
  { name: 'a replay that fits as one chunk', replay: 'abcd', maxLength: 4, expected: ['abcd'] },
  {
    name: 'a long replay into full chunks',
    replay: 'abcdefghij',
    maxLength: 4,
    expected: ['abcd', 'efgh', 'ij'],
  },
  {
    name: 'a replay without cutting a surrogate pair',
    replay: 'abc\u{1F600}de',
    maxLength: 4,
    expected: ['abc', '\u{1F600}de'],
  },
])('#splitReplayChunks splits $name', (row) => {
  expect(splitReplayChunks(row.replay, row.maxLength)).toStrictEqual(row.expected);
});
