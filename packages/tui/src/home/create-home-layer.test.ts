import { expect, onTestFinished, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import { quantiseColour } from '../compositor/quantise-colour';
import { renderFrameDiff } from '../compositor/render-frame-diff';
import type { ColourDepth } from '../compositor/types';
import { createSessionEmulator } from '../emulator/create-session-emulator';
import { createHomeLayer } from './create-home-layer';
import type { HomeInput } from './types';

function setupTest(input: Partial<HomeInput>) {
  const layer = createHomeLayer({
    readInput: () => ({
      sessionCount: 0,
      needYouCount: 0,
      leaderLabel: 'ctrl+space',
      notices: [],
      restorableCount: 0,
      ...input,
    }),
  });

  const drawBuffer = (cols: number, rows: number, depth: ColourDepth) => {
    const buffer = buildCellBuffer(cols, rows);

    layer.draw(buffer, {
      now: 0,
      cols,
      rows,
      terminal: {
        depth,
        background: { red: 0, green: 0, blue: 0 },
        foreground: { red: 255, green: 255, blue: 255 },
        kittyKeyboard: false,
      },
    });

    return buffer;
  };

  const draw = (cols: number, rows: number) => {
    const buffer = drawBuffer(cols, rows, 'truecolor');

    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_unused, col) => buffer.get(col, row).ch)
        .join('')
        .trimEnd(),
    ).filter((line) => line !== '');
  };

  // every colour a cell sets, as the terminal at `depth` would show it
  const drawColours = (cols: number, rows: number, depth: ColourDepth) => {
    const buffer = drawBuffer(cols, rows, depth);

    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_unused, col) => buffer.get(col, row)),
    )
      .flat()
      .flatMap((cell) => [cell.fg, cell.bg])
      .filter((colour) => colour.kind !== 'default')
      .map((colour) => quantiseColour(colour, depth));
  };

  // the rows a terminal shows after it takes the frame's escape sequences
  const drawOnTerminal = async (cols: number, rows: number) => {
    const buffer = drawBuffer(cols, rows, 'truecolor');

    const terminal = createSessionEmulator({
      cols,
      rows,
      readFacts: () => ({
        depth: 'truecolor',
        background: { red: 0, green: 0, blue: 0 },
        foreground: { red: 255, green: 255, blue: 255 },
        kittyKeyboard: false,
      }),
    });

    onTestFinished(() => {
      terminal.dispose();
    });

    await terminal.write(renderFrameDiff(buildCellBuffer(cols, rows), buffer, 'truecolor'));

    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_unused, col) => terminal.readCell(col, row).ch)
        .join('')
        .trimEnd(),
    ).filter((line) => line !== '');
  };

  return { layer, draw, drawColours, drawOnTerminal };
}

test('#draw shows the text wordmark, the fleet line and the keys in a small window', () => {
  const ctx = setupTest({ sessionCount: 2, needYouCount: 1 });

  expect(ctx.draw(40, 9)).toStrictEqual([
    '                  atc',
    '      2 sessions  ·  ◆ 1 need you',
    '          ctrl+space  sessions',
    '                   n  new',
  ]);
});

test('#draw draws the bitmap wordmark in half-cell blocks', () => {
  const ctx = setupTest({});
  const lines = ctx.draw(60, 20);

  expect(lines.slice(0, 4)).toStrictEqual([
    '                             ▄',
    '                    ▄▄▄▄▄  ▄▄▀▄▄  ▄▄▄▄▄',
    '                   ▀    ▀    ▀   ▀',
    '                   ▀▄▄▄▄▀    ▀   ▀▄▄▄▄▄',
  ]);
});

test('#draw leaves a pixel that 16 colours would show as black at the terminal default', () => {
  const ctx = setupTest({});
  const colours = ctx.drawColours(170, 50, '16');

  expect([
    colours.length > 0,
    colours.filter((colour) => colour.kind === 'palette' && colour.index === 0),
  ]).toStrictEqual([true, []]);
});

test('#draw shows a notice with wide characters on the terminal with no gap', async () => {
  const ctx = setupTest({ notices: ['kept ~/作業/demo'] });

  const lines = await ctx.drawOnTerminal(60, 9);

  expect(lines.at(-1)).toBe(`${' '.repeat(22)}kept ~/作業/demo`);
});

test('#nextFrameAt asks for no frame', () => {
  const ctx = setupTest({});

  expect(ctx.layer.nextFrameAt(1000)).toBeNull();
});
