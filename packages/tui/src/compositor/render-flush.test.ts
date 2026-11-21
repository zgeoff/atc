import { expect, test } from 'bun:test';
import { BLANK_CELL } from './blank-cell';
import { buildCellBuffer } from './build-cell-buffer';
import { renderFlush } from './render-flush';
import type { CursorPlacement } from './types';

function setupTest() {
  const visible: CursorPlacement = { col: 2, row: 1, visible: true, shape: 'bar' };
  const defaultCols = 8;

  const buildBuffer = (text: string, cols = defaultCols) => {
    const buffer = buildCellBuffer(cols, 2);

    for (const [col, ch] of [...text].entries()) {
      buffer.set(col, 0, { ...BLANK_CELL, ch });
    }

    return buffer;
  };

  return { buildBuffer, visible };
}

test('#renderFlush clears the terminal and draws a first frame in one synchronized write', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: null,
    next: ctx.buildBuffer('hi'),
    depth: 'truecolor',
    cursor: null,
    shownCursor: null,
  });

  expect(plan.output).toBe(
    '\u001B[?2026h\u001B[0m\u001B[2J\u001B[1;1H\u001B[0mhi\u001B[0m\u001B[?25l\u001B[?2026l',
  );
});

test('#renderFlush writes nothing for an unchanged frame and cursor', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: ctx.buildBuffer('hi'),
    next: ctx.buildBuffer('hi'),
    depth: 'truecolor',
    cursor: null,
    shownCursor: { col: 0, row: 0, visible: false, shape: 'block' },
  });

  expect(plan.output).toBe('');
});

test('#renderFlush places a visible cursor with its shape after the changed cells', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: ctx.buildBuffer('hi'),
    next: ctx.buildBuffer('ho'),
    depth: 'truecolor',
    cursor: ctx.visible,
    shownCursor: { col: 0, row: 0, visible: false, shape: 'block' },
  });

  expect(plan.output).toBe(
    '\u001B[?2026h\u001B[1;2H\u001B[0mo\u001B[0m\u001B[2;3H\u001B[5 q\u001B[?25h\u001B[?2026l',
  );
});

test('#renderFlush hides a visible cursor while it draws', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: ctx.buildBuffer('hi'),
    next: ctx.buildBuffer('ho'),
    depth: 'truecolor',
    cursor: ctx.visible,
    shownCursor: ctx.visible,
  });

  expect(plan.output).toStartWith('\u001B[?2026h\u001B[?25l');
});

test('#renderFlush moves only the cursor when the cells are unchanged', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: ctx.buildBuffer('hi'),
    next: ctx.buildBuffer('hi'),
    depth: 'truecolor',
    cursor: ctx.visible,
    shownCursor: { col: 0, row: 0, visible: true, shape: 'bar' },
  });

  expect(plan.output).toBe('\u001B[?2026h\u001B[2;3H\u001B[5 q\u001B[?25h\u001B[?2026l');
});

test('#renderFlush repaints a frame of another size from a clear', () => {
  const ctx = setupTest();

  const plan = renderFlush({
    shown: ctx.buildBuffer('hi', 8),
    next: ctx.buildBuffer('hi', 10),
    depth: 'truecolor',
    cursor: null,
    shownCursor: null,
  });

  expect(plan.output).toInclude('\u001B[2J');
});
