import { expect, onTestFinished, test } from 'bun:test';
import { NO_INPUT_MODES } from '@atc/core';
import type { InputModes } from '@atc/core';
import type { Underline } from '../compositor/types';
import { createSessionEmulator } from './create-session-emulator';

function setupTest(kittyKeyboard = false) {
  const emulator = createSessionEmulator({
    cols: 20,
    rows: 5,
    readFacts: () => ({
      depth: 'truecolor',
      background: { red: 1, green: 2, blue: 3 },
      foreground: { red: 250, green: 251, blue: 252 },
      kittyKeyboard,
    }),
  });

  const replies: string[] = [];
  const passed: string[] = [];

  emulator.onReply((bytes) => {
    replies.push(bytes);
  });

  emulator.onPassthrough((sequence) => {
    passed.push(sequence);
  });

  onTestFinished(() => {
    emulator.dispose();
  });

  return { emulator, replies, passed };
}

test('#write resolves once the text is parsed and readCell shows it', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('hi');

  expect([ctx.emulator.readCell(0, 0).ch, ctx.emulator.readCell(1, 0).ch]).toStrictEqual([
    'h',
    'i',
  ]);
});

test('#readCell maps a colour and the attributes of a cell', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('\u001B[1;3;9;4:3;7;38;2;1;2;3;48;5;200mx');

  expect(ctx.emulator.readCell(0, 0)).toStrictEqual({
    ch: 'x',
    fg: { kind: 'rgb', red: 1, green: 2, blue: 3 },
    bg: { kind: 'palette', index: 200 },
    bold: true,
    dim: false,
    italic: true,
    underline: 'curly',
    strikethrough: true,
    inverse: true,
    link: null,
  });
});

test('#readCell gives a wide grapheme in one cell and an empty string in the next', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('界x');

  expect([
    ctx.emulator.readCell(0, 0).ch,
    ctx.emulator.readCell(1, 0).ch,
    ctx.emulator.readCell(2, 0).ch,
  ]).toStrictEqual(['界', '', 'x']);
});

test.each(['😀', '✅', '👩‍💻', '👍🏽', '❤️', '🇯🇵', '界'])(
  '#write measures %s as two columns, as a terminal does',
  async (text) => {
    const ctx = setupTest();

    await ctx.emulator.write(text);

    expect(ctx.emulator.readCursor().col).toBe(2);
  },
);

test.each<{ name: string; data: string; expected: Underline }>([
  { name: 'no underline the agent never set', data: 'ab', expected: 'none' },
  { name: 'the underline the agent set', data: '\u001B[4:3mab', expected: 'curly' },
])('#readCell reads a link cell with $name', async (row) => {
  const ctx = setupTest();

  await ctx.emulator.write(`\u001B]8;;https://example.test\u001B\\${row.data}`);

  expect(ctx.emulator.readCell(0, 0).underline).toBe(row.expected);
});

test.each<{ name: string; data: string; expected: Partial<InputModes> }>([
  {
    name: 'the last mouse mode set',
    data: '\u001B[?1003h\u001B[?1000h',
    expected: { mouse: 'click' },
  },
  {
    name: 'mouse off after another mouse mode resets',
    data: '\u001B[?1003h\u001B[?1000l',
    expected: {},
  },
  { name: 'X10 mouse', data: '\u001B[?9h', expected: { mouse: 'x10' } },
  {
    name: 'a soft reset of the keys and the keypad',
    data: '\u001B[?1h\u001B=\u001B[!p',
    expected: {},
  },
  {
    name: 'a control byte inside a CSI',
    data: '\u001B[?20\r04h',
    expected: { bracketedPaste: true },
  },
])('#readInputModes reads $name as xterm does', async (row) => {
  const ctx = setupTest();

  await ctx.emulator.write(row.data);

  expect(ctx.emulator.readInputModes()).toStrictEqual({ ...NO_INPUT_MODES, ...row.expected });
});

test('#readCell reads an OSC 8 link as the link of the cells it covers', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('\u001B]8;;https://example.test\u0007ab\u001B]8;;\u0007c');

  expect([
    ctx.emulator.readCell(0, 0).link,
    ctx.emulator.readCell(1, 0).link,
    ctx.emulator.readCell(2, 0).link,
  ]).toStrictEqual(['https://example.test', 'https://example.test', null]);
});

test('#readCursor gives the position, visibility and shape', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('ab\u001B[?25l\u001B[3 q');

  expect(ctx.emulator.readCursor()).toStrictEqual({
    col: 2,
    row: 0,
    visible: false,
    shape: 'underline',
  });
});

test('#readInputModes follows the modes the session sets', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('\u001B[?2004h\u001B[?1h');

  expect(ctx.emulator.readInputModes()).toMatchObject({
    bracketedPaste: true,
    applicationCursorKeys: true,
  });
});

test('#reset forgets the screen and the modes', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('hi\u001B[?2004h');
  await ctx.emulator.reset();

  expect([
    ctx.emulator.readCell(0, 0).ch,
    ctx.emulator.readInputModes().bracketedPaste,
  ]).toStrictEqual([' ', false]);
});

test('#resize changes the size the emulator reports', () => {
  const ctx = setupTest();

  ctx.emulator.resize(30, 8);

  expect(ctx.emulator.readSize()).toStrictEqual({ cols: 30, rows: 8 });
});

test('#onReply answers a cursor position query', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('abc\u001B[6n');

  expect(ctx.replies).toStrictEqual(['\u001B[1;4R']);
});

test('#onReply answers an OSC 11 query from the terminal facts', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('\u001B]11;?\u0007');

  expect(ctx.replies).toStrictEqual(['\u001B]11;rgb:0101/0202/0303\u001B\\']);
});

test('#onReply answers an OSC 10 query from the terminal facts', async () => {
  const ctx = setupTest();

  await ctx.emulator.write('\u001B]10;?\u0007');

  expect(ctx.replies).toStrictEqual(['\u001B]10;rgb:fafa/fbfb/fcfc\u001B\\']);
});

test('#onReply answers a kitty keyboard query with the current flags when the terminal has the protocol', async () => {
  const ctx = setupTest(true);

  await ctx.emulator.write('\u001B[>5u\u001B[?u');

  expect(ctx.replies).toStrictEqual(['\u001B[?5u']);
});

test('#onReply sends no answer to a kitty keyboard query when the terminal lacks the protocol', async () => {
  const ctx = setupTest(false);

  await ctx.emulator.write('\u001B[>5u\u001B[?u');

  expect(ctx.replies).toStrictEqual([]);
});

test.each<{ name: string; data: string; expected: string[] }>([
  { name: 'the clipboard', data: '\u001B]52;c;aGk=\u0007', expected: ['\u001B]52;c;aGk=\u0007'] },
  { name: 'a window title', data: '\u001B]2;build\u0007', expected: ['\u001B]2;build\u0007'] },
  { name: 'an icon and title', data: '\u001B]0;build\u0007', expected: ['\u001B]0;build\u0007'] },
  {
    name: 'a desktop notification',
    data: '\u001B]9;done\u0007',
    expected: ['\u001B]9;done\u0007'],
  },
  {
    name: 'a rich notification',
    data: '\u001B]777;notify;t;b\u0007',
    expected: ['\u001B]777;notify;t;b\u0007'],
  },
  { name: 'the bell', data: '\u0007', expected: ['\u0007'] },
  { name: 'nothing for a clipboard read', data: '\u001B]52;c;?\u0007', expected: [] },
  {
    name: 'nothing for a working directory report',
    data: '\u001B]7;file:///tmp\u0007',
    expected: [],
  },
  { name: 'nothing for a shell integration mark', data: '\u001B]133;A\u0007', expected: [] },
])('#onPassthrough passes on $name', async (row) => {
  const ctx = setupTest();

  await ctx.emulator.write(row.data);

  expect(ctx.passed).toStrictEqual(row.expected);
});

test('#onReply answers a kitty keyboard query with the flags at its place in the chunk', async () => {
  const ctx = setupTest(true);

  await ctx.emulator.write('\u001B[>1u\u001B[?u\u001B[>5u');

  expect([ctx.replies, ctx.emulator.readInputModes().kittyStack]).toStrictEqual([
    ['\u001B[?1u'],
    [1, 5],
  ]);
});
