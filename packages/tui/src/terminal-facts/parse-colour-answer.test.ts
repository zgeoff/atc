import { expect, test } from 'bun:test';
import { parseColourAnswer } from './parse-colour-answer';

test.each<{ data: string; expected: { red: number; green: number; blue: number } | null }>([
  { data: 'rgb:0000/0000/0000', expected: { red: 0, green: 0, blue: 0 } },
  { data: 'rgb:ffff/ffff/ffff', expected: { red: 255, green: 255, blue: 255 } },
  { data: 'rgb:0d0d/1111/1717', expected: { red: 13, green: 17, blue: 23 } },
  { data: 'rgb:ff/00/80', expected: { red: 255, green: 0, blue: 128 } },
  { data: 'rgb:f/0/8', expected: { red: 255, green: 0, blue: 136 } },
  { data: '#0d1117', expected: { red: 13, green: 17, blue: 23 } },
  { data: '#fff', expected: { red: 255, green: 255, blue: 255 } },
  { data: 'rgb:zz/00/00', expected: null },
  { data: 'blue', expected: null },
])('#parseColourAnswer reads $data', (row) => {
  expect(parseColourAnswer(row.data)).toStrictEqual(row.expected);
});
