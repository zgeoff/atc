import { expect, test } from 'bun:test';
import { createTerminalAnswerFilter } from './create-terminal-answer-filter';
import type { TerminalAnswer } from './create-terminal-answer-filter';

test.each<{ name: string; chunks: string[]; keys: string[]; answers: TerminalAnswer[] }>([
  { name: 'plain keys through', chunks: ['abc'], keys: ['abc'], answers: [] },
  {
    name: 'an OSC 11 answer ended by BEL',
    chunks: ['\u001B]11;rgb:0000/0000/ffff\u0007'],
    keys: [''],
    answers: [{ kind: 'background', colour: { red: 0, green: 0, blue: 255 } }],
  },
  {
    name: 'an OSC 10 answer ended by ST between keys',
    chunks: ['a\u001B]10;rgb:ffff/0000/0000\u001B\\b'],
    keys: ['ab'],
    answers: [{ kind: 'foreground', colour: { red: 255, green: 0, blue: 0 } }],
  },
  { name: 'a kitty answer', chunks: ['\u001B[?31u'], keys: [''], answers: [{ kind: 'kitty' }] },
  {
    name: 'a device attributes answer',
    chunks: ['\u001B[?62;4c'],
    keys: [''],
    answers: [{ kind: 'attributes' }],
  },
  {
    name: 'an answer split across chunks',
    chunks: ['\u001B]11;rgb:00', '00/0000/ffff\u0007x'],
    keys: ['', 'x'],
    answers: [{ kind: 'background', colour: { red: 0, green: 0, blue: 255 } }],
  },
  {
    name: 'a kitty answer split after the question mark',
    chunks: ['\u001B[?', '5u'],
    keys: ['', ''],
    answers: [{ kind: 'kitty' }],
  },
  { name: 'a lone escape key through', chunks: ['\u001B'], keys: ['\u001B'], answers: [] },
  { name: 'an arrow key through', chunks: ['\u001B[A'], keys: ['\u001B[A'], answers: [] },
  {
    name: 'a kitty key event through',
    chunks: ['\u001B[97;5u'],
    keys: ['\u001B[97;5u'],
    answers: [],
  },
])('#push takes $name', (row) => {
  const filter = createTerminalAnswerFilter();
  const keys: string[] = [];
  const answers: TerminalAnswer[] = [];

  for (const chunk of row.chunks) {
    const result = filter.push(chunk);

    keys.push(result.keys);
    answers.push(...result.answers);
  }

  expect([keys, answers]).toStrictEqual([row.keys, row.answers]);
});
