import { expect, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import { buildFleetBar } from './build-fleet-bar';
import { createFleetBarLayer } from './create-fleet-bar-layer';

interface BarState {
  readonly label?: string;
  readonly isShown: boolean;
  readonly isSpinning: boolean;
}

function setupTest(state: BarState) {
  const layer = createFleetBarLayer({
    isShown: () => state.isShown,
    isSpinning: () => state.isSpinning,
    readBar: (cols, spinnerFrame) =>
      buildFleetBar(
        [
          {
            daemon: null,
            state: 'running',
            target: 'box',
            place: { key: 'a', label: state.label ?? 'laptop' },
          },
          {
            daemon: null,
            state: 'needs_you',
            target: 'box',
            place: { key: 'a', label: state.label ?? 'laptop' },
          },
        ],
        { cols, leaderLabel: 'ctrl+space', attachedPlaceKey: 'a', spinnerFrame },
      ),
  });

  const frame = {
    now: 250,
    cols: 40,
    rows: 5,
    terminal: {
      depth: 'truecolor' as const,
      background: { red: 0, green: 0, blue: 0 },
      foreground: { red: 255, green: 255, blue: 255 },
      kittyKeyboard: false,
    },
  };

  const readRow = (row: number, buffer: ReturnType<typeof buildCellBuffer>) =>
    Array.from({ length: frame.cols }, (_, col) => buffer.get(col, row).ch).join('');

  return { layer, frame, readRow };
}

test('#draw writes the bar on the last row and leaves the other rows alone', () => {
  const ctx = setupTest({ isShown: true, isSpinning: true });
  const buffer = buildCellBuffer(ctx.frame.cols, ctx.frame.rows);

  ctx.layer.draw(buffer, ctx.frame);

  expect([ctx.readRow(4, buffer), ctx.readRow(3, buffer)]).toStrictEqual([
    `laptop ◆⠹${' '.repeat(15)}◆ 1   ctrl+space`,
    ' '.repeat(40),
  ]);
});

test('#draw gives a wide label two columns, so the glyphs after it keep their place', () => {
  const ctx = setupTest({ isShown: true, isSpinning: true, label: '界' });
  const buffer = buildCellBuffer(ctx.frame.cols, ctx.frame.rows);

  ctx.layer.draw(buffer, ctx.frame);

  expect(Array.from({ length: 6 }, (_, col) => buffer.get(col, 4).ch)).toStrictEqual([
    '界',
    '',
    ' ',
    '◆',
    '⠹',
    ' ',
  ]);
});

test('#draw paints no background', () => {
  const ctx = setupTest({ isShown: true, isSpinning: true });
  const buffer = buildCellBuffer(ctx.frame.cols, ctx.frame.rows);

  ctx.layer.draw(buffer, ctx.frame);

  expect(buffer.get(0, 4).bg).toStrictEqual({ kind: 'default' });
});

test('#draw writes nothing while a notice, home or a prompt has the row', () => {
  const ctx = setupTest({ isShown: false, isSpinning: true });
  const buffer = buildCellBuffer(ctx.frame.cols, ctx.frame.rows);

  ctx.layer.draw(buffer, ctx.frame);

  expect(ctx.readRow(4, buffer)).toBe(' '.repeat(40));
});

test.each([
  {
    title: 'the next 100 ms step while a session runs',
    isShown: true,
    isSpinning: true,
    next: 300,
  },
  { title: 'nothing while no session runs', isShown: true, isSpinning: false, next: null },
  { title: 'nothing while the bar is hidden', isShown: false, isSpinning: true, next: null },
])('#nextFrameAt asks for $title', (row) => {
  const ctx = setupTest({ isShown: row.isShown, isSpinning: row.isSpinning });

  expect(ctx.layer.nextFrameAt(250)).toBe(row.next);
});
