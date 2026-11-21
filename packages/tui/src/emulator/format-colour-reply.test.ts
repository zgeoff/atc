import { expect, test } from 'bun:test';
import { formatColourReply } from './format-colour-reply';

test.each<{ code: 10 | 11; red: number; green: number; blue: number; expected: string }>([
  { code: 11, red: 13, green: 17, blue: 23, expected: '\u001B]11;rgb:0d0d/1111/1717\u001B\\' },
  { code: 10, red: 255, green: 0, blue: 128, expected: '\u001B]10;rgb:ffff/0000/8080\u001B\\' },
])('#formatColourReply answers OSC $code for $r,$g,$b', (row) => {
  expect(formatColourReply(row.code, { red: row.red, green: row.green, blue: row.blue })).toBe(
    row.expected,
  );
});
