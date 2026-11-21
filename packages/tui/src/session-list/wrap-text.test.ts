import { expect, test } from 'bun:test';
import { wrapText } from './wrap-text';

test.each([
  {
    title: 'a short text on one line',
    text: 'end api? · y / n',
    width: 20,
    expected: ['end api? · y / n'],
  },
  {
    title: 'a long text broken at spaces',
    text: 'end orders? stops the agent · y / n',
    width: 17,
    expected: ['end orders? stops', 'the agent · y / n'],
  },
  {
    title: 'a word wider than the line cut with an ellipsis',
    text: 'end orchard-inventory? y',
    width: 10,
    expected: ['end', 'orchard-i…', 'y'],
  },
] as const)('#wrapText gives $title', (row) => {
  expect(wrapText(row.text, row.width)).toStrictEqual([...row.expected]);
});
