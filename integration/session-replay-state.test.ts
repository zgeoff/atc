import { expect, onTestFinished, test } from 'bun:test';
import { createScreenModel } from '@atc/daemon';
import { createSessionEmulator } from '@atc/tui';

function setupTest() {
  const size = { cols: 20, rows: 6 };

  const facts = {
    depth: 'truecolor' as const,
    background: { red: 0, green: 0, blue: 0 },
    foreground: { red: 255, green: 255, blue: 255 },
    kittyKeyboard: true,
  };

  const readFacts = () => facts;
  const model = createScreenModel(size.cols, size.rows);
  const direct = createSessionEmulator({ ...size, readFacts });
  const replayed = createSessionEmulator({ ...size, readFacts });

  onTestFinished(() => {
    model.stop();
    direct.dispose();
    replayed.dispose();
  });

  const readScreens = () =>
    [direct, replayed].map((emulator) => ({
      rows: Array.from({ length: size.rows }, (_, row) =>
        Array.from({ length: size.cols }, (_unused, col) => emulator.readCell(col, row)),
      ),
      cursor: emulator.readCursor(),
      modes: emulator.readInputModes(),
    }));

  return { model, direct, replayed, readScreens };
}

test.each([
  { name: 'the cursor DECSC saved', before: 'ab\u001B7\u001B[4;9Hz', after: '\u001B8X' },
  { name: 'the pen DECSC saved', before: '\u001B[32m\u001B7\u001B[0mq', after: '\u001B8X' },
  { name: 'the current pen', before: 'a\u001B[1;31;4mb', after: 'c' },
  { name: 'custom tab stops', before: '\u001B[3g\u001B[1;4H\u001BH\u001B[1;1H', after: '\tX' },
  { name: 'the DEC line-drawing charset', before: '\u001B(0', after: 'qqq' },
  { name: 'a charset shifted into G1', before: '\u001B)0\u000E', after: 'qx' },
  { name: 'a wrap pending at the last column', before: 'x'.repeat(20), after: 'Z' },
  { name: 'a wrap pending after a wide grapheme', before: `${'x'.repeat(18)}漢`, after: 'Z' },
  { name: 'the cursor shape', before: '\u001B[6 q', after: '' },
  { name: 'a curly coloured underline', before: '\u001B[4:3;58;2;9;8;7mS\u001B[0m', after: '' },
  {
    name: 'every SGR attribute',
    before: '\u001B[1;2;3;4:2;5;7;8;9;53;38;5;100;48;2;1;2;3mS\u001B[0m',
    after: '',
  },
  {
    name: 'a link over wide text',
    before: '\u001B]8;;https://example.test/a\u0007漢字link\u001B]8;;\u0007 plain',
    after: 'z',
  },
  { name: 'emoji widths', before: '👍🏽🇳🇿👩‍💻❤️x', after: 'y' },
  {
    name: 'the normal screen cursor under the alternate screen',
    before: 'normal\u001B[3;5H\u001B[?1049halt',
    after: '\u001B[?1049lX',
  },
  {
    name: 'a kitty stack on each screen',
    before: '\u001B[>1u\u001B[?1049h\u001B[>3u\u001B[>7u',
    after: '\u001B[<u\u001B[?1049l',
  },
])('it restores $name through a full replay', async (row) => {
  const ctx = setupTest();

  ctx.model.record(row.before);

  await ctx.direct.write(row.before);

  const captured = await ctx.model.captureStateReplay(() => 0);

  await ctx.replayed.write(captured.replay);
  await Promise.all([ctx.direct.write(row.after), ctx.replayed.write(row.after)]);

  const [direct, replayed] = ctx.readScreens();

  expect(replayed).toStrictEqual(direct);
});

test('it leaves the scrollback out of a full replay', async () => {
  const ctx = setupTest();
  const history = Array.from({ length: 200 }, (_, line) => `history line ${line}`).join('\r\n');

  ctx.model.record(history);

  const captured = await ctx.model.captureStateReplay(() => 0);

  expect(captured.replay).not.toInclude('history line 100');
});
