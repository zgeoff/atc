import { expect, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
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

  const draw = (cols: number, rows: number) => {
    const buffer = buildCellBuffer(cols, rows);

    layer.draw(buffer, {
      now: 0,
      cols,
      rows,
      terminal: {
        depth: 'truecolor',
        background: { red: 0, green: 0, blue: 0 },
        foreground: { red: 255, green: 255, blue: 255 },
        kittyKeyboard: false,
      },
    });

    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_unused, col) => buffer.get(col, row).ch)
        .join('')
        .trimEnd(),
    ).filter((line) => line !== '');
  };

  return { layer, draw };
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

test('#nextFrameAt asks for no frame', () => {
  const ctx = setupTest({});

  expect(ctx.layer.nextFrameAt(1000)).toBeNull();
});
