import { expect, test } from 'bun:test';
import { KEYS } from '@atc/core/test-utils/keys';
import { splitKeys } from './split-keys';

test.each([
  { title: 'letters', chunk: 'ap', keys: ['a', 'p'] },
  { title: 'two backspaces', chunk: '\u007F\u007F', keys: ['\u007F', '\u007F'] },
  { title: 'text and its enter', chunk: `web${KEYS.enter}`, keys: ['w', 'e', 'b', KEYS.enter] },
  { title: 'the leader and a letter', chunk: `${KEYS.ctrlSpace}i`, keys: [KEYS.ctrlSpace, 'i'] },
  { title: 'arrow keys', chunk: `${KEYS.up}${KEYS.down}`, keys: [KEYS.up, KEYS.down] },
  { title: 'an SS3 arrow and a letter', chunk: '\u001BOAj', keys: ['\u001BOA', 'j'] },
  { title: 'a kitty key and a letter', chunk: '\u001B[32;5uj', keys: ['\u001B[32;5u', 'j'] },
  {
    title: 'a paste opener and text',
    chunk: `${KEYS.pasteOpen}hi`,
    keys: [KEYS.pasteOpen, 'h', 'i'],
  },
  { title: 'two lone escapes', chunk: '\u001B\u001B', keys: ['\u001B', '\u001B'] },
  { title: 'an alt key and a letter', chunk: '\u001Bxj', keys: ['\u001Bx', 'j'] },
  { title: 'characters of several bytes', chunk: 'é界🍐', keys: ['é', '界', '🍐'] },
])('#splitKeys splits $title into one piece per key', (row) => {
  expect(splitKeys(Buffer.from(row.chunk)).map((key) => key.toString())).toStrictEqual([
    ...row.keys,
  ]);
});

test('#splitKeys keeps the bytes of a cut-off character, so the pieces join back to the chunk', () => {
  const chunk = Buffer.from([0x61, 0xe7, 0x95]);

  expect(Buffer.concat(splitKeys(chunk))).toStrictEqual(chunk);
});
