import { buildCellBuffer } from './build-cell-buffer';
import { renderFrameDiff } from './render-frame-diff';
import type { CellBuffer, ColourDepth, CursorPlacement, CursorShape } from './types';

const ESC = '\u001B';

export interface FlushInput {
  readonly shown: CellBuffer | null;
  readonly next: CellBuffer;
  readonly depth: ColourDepth;
  readonly cursor: CursorPlacement | null;
  readonly shownCursor: CursorPlacement | null;
}

export interface FlushPlan {
  readonly output: string;
  readonly shownCursor: CursorPlacement | null;
}

const HIDDEN: CursorPlacement = { col: 0, row: 0, visible: false, shape: 'block' };

// One synchronized-output write: the changed cells, then the cursor. A frame that changes
// nothing gives an empty output. A first frame, or one of another size, clears the terminal and
// draws every non-blank cell.
export function renderFlush(input: FlushInput): FlushPlan {
  const isSameSize =
    input.shown !== null &&
    input.shown.cols === input.next.cols &&
    input.shown.rows === input.next.rows;

  const baseline =
    isSameSize && input.shown !== null
      ? input.shown
      : buildCellBuffer(input.next.cols, input.next.rows);

  const clear = isSameSize ? '' : `${ESC}[0m${ESC}[2J`;
  const cells = renderFrameDiff(baseline, input.next, input.depth);
  const placed = input.cursor ?? HIDDEN;
  const shownCursor = input.cursor === null ? HIDDEN : input.cursor;
  const cursorMoved = cells !== '' || clear !== '' || !isSameCursor(placed, input.shownCursor);

  if (!cursorMoved) {
    return { output: '', shownCursor: input.shownCursor };
  }

  const hideWhileDrawing = (cells !== '' || clear !== '') && input.shownCursor?.visible === true;
  const prefix = hideWhileDrawing ? `${ESC}[?25l` : '';

  return {
    output: `${ESC}[?2026h${prefix}${clear}${cells}${formatCursor(placed)}${ESC}[?2026l`,
    shownCursor,
  };
}

function isSameCursor(left: CursorPlacement, right: CursorPlacement | null): boolean {
  if (right === null) {
    return false;
  }

  if (!left.visible) {
    return !right.visible;
  }

  return (
    right.visible && left.col === right.col && left.row === right.row && left.shape === right.shape
  );
}

function formatCursor(cursor: CursorPlacement): string {
  if (!cursor.visible) {
    return `${ESC}[?25l`;
  }

  return `${ESC}[${cursor.row + 1};${cursor.col + 1}H${ESC}[${pickShapeCode(cursor.shape)} q${ESC}[?25h`;
}

function pickShapeCode(shape: CursorShape): number {
  if (shape === 'underline') {
    return 3;
  }

  return shape === 'bar' ? 5 : 1;
}
