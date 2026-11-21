import { expect, onTestFinished, test } from 'bun:test';
import { RESET_INPUT_MODES, createInputModeTracker } from '@atc/core';
import { Terminal } from '@xterm/headless';
import { waitFor } from '@zgeoff/testing';
import { createScreenModel } from './create-screen-model';
import { findCellLink } from './find-cell-link';

test('it replays text written to the screen', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello fleet');

  const replay = await model.captureReplay();

  expect(replay).toInclude('hello fleet');
});

test('it measures an emoji as two columns, as a terminal does', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('❤️ab\u001B[1;3HZ');

  const screen = await model.captureText();

  expect(screen.text).toBe('❤️Zb');
});

test('it gives a full replay the kitty stack of each screen', async () => {
  const model = createScreenModel(40, 10);
  const tracker = createInputModeTracker();

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[>1u\u001B[?1049h\u001B[>3u');

  const captured = await model.captureStateReplay(() => 0);

  tracker.write(captured.replay);

  expect(tracker.readKittyStacks()).toStrictEqual({ main: [1], alternate: [3] });
});

test('it gives a full replay the size it renders at once a resize applies, and the mark it reads', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.updateDims(100, 30);

  const captured = await model.captureFullReplay(() => 'mark-7');

  expect(captured).toMatchObject({ cols: 100, rows: 30, mark: 'mark-7' });
});

test('it drops cleared content from the replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('stale screen\r\n');

  await model.captureReplay();

  model.record('\u001B[2J\u001B[Hfresh screen');

  const replay = await model.captureReplay();

  expect(replay).toInclude('fresh screen');
  expect(replay).not.toInclude('stale screen');
});

test('it includes bytes recorded while a replay is pending', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('first');

  await model.captureReplay();

  const replay = model.captureReplay();

  model.record(' second');

  const rendered = await replay;

  expect(rendered).toInclude('second');
});

test('it replays only the visible screen for a session on the alternate buffer', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('normal residue\r\n\u001B[?1049haltscreen content');

  const replay = await model.captureReplay();

  expect(replay).toInclude('altscreen content');
  expect(replay).not.toInclude('\u001B[?1049h');
  expect(replay).not.toInclude('normal residue');
});

test('it replays the normal buffer, then switches to the alternate buffer, in a full replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('normal residue\r\n\u001B[?1049haltscreen content');

  const captured = await model.captureFullReplay(() => null);

  const replay = captured.replay;

  expect(replay.indexOf('normal residue')).toBeGreaterThan(-1);
  expect(replay.indexOf('\u001B[?1049h')).toBeGreaterThan(replay.indexOf('normal residue'));
  expect(replay.indexOf('altscreen content')).toBeGreaterThan(replay.indexOf('\u001B[?1049h'));
});

test('it preserves colors and cursor positioning in the replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[5;10H\u001B[1;31malert\u001B[0m');

  const replay = await model.captureReplay();

  expect(replay).toEndWith('\r\n\r\n\r\n\r\n\u001B[9C\u001B[31;1malert\u001B[0m');
});

test('it keeps replaying after a resize', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('before resize\r\n');

  await model.captureReplay();

  model.updateDims(30, 8);
  model.record('after resize');

  const replay = await model.captureReplay();

  expect(replay).toInclude('after resize');
});

test('it re-emits SGR mouse encoding and alternate scroll in the replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?1000h\u001B[?1006h\u001B[?1007h');

  const replay = await model.captureReplay();

  expect(replay).toInclude('\u001B[?1006h');
  expect(replay).toInclude('\u001B[?1007h');
});

test('it restores the kitty keyboard push and modifyOtherKeys in the replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[>1u\u001B[>4;2m');

  const replay = await model.captureReplay();

  expect(replay).toInclude('\u001B[>1u');
  expect(replay).toInclude('\u001B[>4;2m');
});

test('it drops popped and reset input modes from the replay', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?1006h\u001B[>1u\u001B[>4;2m');
  model.record('\u001B[?1006l\u001B[<u\u001B[>4;0m');
  model.record('modes reset');

  const replay = await model.captureReplay();

  expect(replay).toInclude('modes reset');
  expect(replay).not.toInclude('\u001B[?1006h');
  expect(replay).not.toInclude('\u001B[>1u');
  expect(replay).not.toInclude('\u001B[>4;2m');
});

test('it re-emits a mode whose set sequence arrived split across chunks', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?10');
  model.record('06h');

  const replay = await model.captureReplay();

  expect(replay).toInclude('\u001B[?1006h');
});

test('it leads the replay with an input-mode reset', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello');

  const replay = await model.captureReplay();

  expect(replay).toStartWith(RESET_INPUT_MODES);
});

test('it renders the visible screen as plain text with trailing blank rows dropped', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('hello fleet\r\n\u001B[32msecond\u001B[0m   ');

  const screen = await waitFor(async () => {
    const rendered = await model.captureText();

    expect(rendered.text).toInclude('second');

    return rendered;
  });

  expect(screen).toStrictEqual({ text: 'hello fleet\nsecond', cols: 40, rows: 10 });
});

test('it renders only the alternate buffer as text for a session on the alternate screen', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('normal screen\r\n');

  await model.captureReplay();

  model.record('\u001B[?1049h\u001B[Halternate screen');

  const screen = await waitFor(async () => {
    const rendered = await model.captureText();

    expect(rendered.text).toInclude('alternate screen');

    return rendered;
  });

  expect(screen.text).toBe('alternate screen');
});

test('it reports bracketed paste on once the tui turns it on', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?2004h');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeTrue();
  });
});

test('it reports bracketed paste off once the tui turns it off', async () => {
  const model = createScreenModel(40, 10);

  onTestFinished(() => {
    model.stop();
  });

  model.record('\u001B[?2004h');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeTrue();
  });

  model.record('\u001B[?2004l');

  await waitFor(() => {
    expect(model.hasBracketedPaste()).toBeFalse();
  });
});

function setupTest() {
  const model = createScreenModel(30, 8);

  const reference = new Terminal({ cols: 30, rows: 8, allowProposedApi: true, scrollback: 300 });
  const rebuilt = new Terminal({ cols: 30, rows: 8, allowProposedApi: true, scrollback: 300 });

  onTestFinished(() => {
    model.stop();
    reference.dispose();
    rebuilt.dispose();
  });

  const readCells = (kind: 'normal' | 'alternate') =>
    [reference, rebuilt].map((term) => {
      const buffer = kind === 'normal' ? term.buffer.normal : term.buffer.alternate;
      const lines: string[] = [];

      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        const cells: string[] = [];

        for (let col = 0; col < term.cols; col++) {
          const cell = line?.getCell(col);
          const link = cell === undefined ? null : findCellLink(term, cell);

          cells.push(
            `${cell?.getChars() ?? ''}/${cell?.getFgColor()}/${cell?.getBgColor()}/${cell?.isBold()}/${link}`,
          );
        }

        lines.push(cells.join(' '));
      }

      return lines;
    });

  return {
    rebuilt,
    reference,
    readCells,
    feed: async (data: string) => {
      model.record(data);

      await new Promise<void>((resolve) => {
        reference.write(data, resolve);
      });
    },
    replay: async () => {
      const captured = await model.captureStateReplay(() => 0);

      await new Promise<void>((resolve) => {
        rebuilt.write(captured.replay, resolve);
      });

      const tracker = createInputModeTracker();

      tracker.write(captured.replay);

      return { replay: captured.replay, modes: tracker.read() };
    },
  };
}

test('it replays the main screen cell for cell', async () => {
  const ctx = setupTest();

  await ctx.feed(
    'plain line\r\n\u001B[1;31mred bold\u001B[0m\r\n\u001B[38;2;10;20;30mrgb\u001B[0m\u001B[4;9H',
  );

  await ctx.replay();

  const [expected, actual] = ctx.readCells('normal');

  expect(actual).toStrictEqual(expected);
});

test('it replays the cursor of the main screen', async () => {
  const ctx = setupTest();

  await ctx.feed('one\r\ntwo\u001B[2;2H');
  await ctx.replay();

  expect([ctx.rebuilt.buffer.active.cursorX, ctx.rebuilt.buffer.active.cursorY]).toStrictEqual([
    ctx.reference.buffer.active.cursorX,
    ctx.reference.buffer.active.cursorY,
  ]);
});

test('it replays both buffers while the alternate screen is active', async () => {
  const ctx = setupTest();

  await ctx.feed('main text\u001B[?1049h\u001B[2J\u001B[3;4Halt text\u001B[1;32m!\u001B[0m');
  await ctx.replay();

  const [expectedAlternate, actualAlternate] = ctx.readCells('alternate');
  const [expectedNormal, actualNormal] = ctx.readCells('normal');

  expect([ctx.rebuilt.buffer.active.type, actualAlternate, actualNormal]).toStrictEqual([
    'alternate',
    expectedAlternate,
    expectedNormal,
  ]);
});

test('it replays the main screen after the alternate screen was left', async () => {
  const ctx = setupTest();

  await ctx.feed('main text\u001B[?1049halt text\u001B[?1049l');
  await ctx.replay();

  const [expectedNormal, actualNormal] = ctx.readCells('normal');

  expect([ctx.rebuilt.buffer.active.type, actualNormal]).toStrictEqual(['normal', expectedNormal]);
});

test('it replays every input mode with the kitty stack re-created', async () => {
  const ctx = setupTest();

  await ctx.feed(
    '\u001B[>1u\u001B[>5u\u001B[?2004h\u001B[?1h\u001B=\u001B[?1002h\u001B[?1006h\u001B[?1004h\u001B[?1007h\u001B[>4;2m\u001B[?2031h',
  );

  const replayed = await ctx.replay();

  expect(replayed.modes).toStrictEqual({
    mouse: 'drag',
    mouseEncoding: 'sgr',
    alternateScroll: true,
    bracketedPaste: true,
    focusEvents: true,
    applicationCursorKeys: true,
    applicationKeypad: true,
    kittyStack: [1, 5],
    modifyOtherKeys: 2,
    colourSchemeUpdates: true,
  });
});

test('it replays a scroll region and a hidden cursor', async () => {
  const ctx = setupTest();

  await ctx.feed('\u001B[2;5r\u001B[?25l\u001B[3;3Hx');

  const replayed = await ctx.replay();

  expect(replayed.replay).toInclude('\u001B[2;5r');
  expect(replayed.replay).toEndWith('\u001B[?25l');
});

test.each([
  { name: 'a scroll region', feed: '\u001B[2;5r\u001B[?6h\u001B[3;3Hx' },
  { name: 'no scroll region', feed: '\u001B[?6h\u001B[3;3Hx' },
])('it replays the cursor of a session in origin mode with $name', async (row) => {
  const ctx = setupTest();

  await ctx.feed(row.feed);
  await ctx.replay();

  expect([
    ctx.rebuilt.buffer.active.cursorX,
    ctx.rebuilt.buffer.active.cursorY,
    ctx.rebuilt.modes.originMode,
  ]).toStrictEqual([
    ctx.reference.buffer.active.cursorX,
    ctx.reference.buffer.active.cursorY,
    true,
  ]);
});

test('it replays the cursor of the alternate screen in origin mode', async () => {
  const ctx = setupTest();

  await ctx.feed('main\u001B[?1049h\u001B[2;5r\u001B[?6h\u001B[3;3Hx');
  await ctx.replay();

  expect([ctx.rebuilt.buffer.active.cursorX, ctx.rebuilt.buffer.active.cursorY]).toStrictEqual([
    ctx.reference.buffer.active.cursorX,
    ctx.reference.buffer.active.cursorY,
  ]);
});

test('it replays the links of the main screen with their attributes', async () => {
  const ctx = setupTest();

  await ctx.feed(
    'a\u001B[1;31m\u001B]8;;https://example.test\u0007link\u001B[0m界\u001B]8;;\u0007 tail\r\n\u001B[4:3m\u001B]8;;https://other.test\u0007two\u001B]8;;\u0007',
  );

  await ctx.replay();

  const [expected, actual] = ctx.readCells('normal');

  expect(actual).toStrictEqual(expected);
  expect(actual?.[0]).toInclude('/https://example.test');
});

test('it replays the links of the alternate screen', async () => {
  const ctx = setupTest();

  await ctx.feed('\u001B[?1049h\u001B[2;3H\u001B]8;;https://example.test\u0007alt\u001B]8;;\u0007');
  await ctx.replay();

  const [expected, actual] = ctx.readCells('alternate');

  expect(actual).toStrictEqual(expected);
  expect(actual?.[1]).toInclude('/https://example.test');
});
