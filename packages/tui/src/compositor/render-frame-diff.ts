import { BLANK_CELL } from './blank-cell';
import { formatSGR } from './format-sgr';
import { isSameCell, isSameStyle } from './is-same-cell';
import type { Cell, CellBuffer, ColourDepth } from './types';

const ESC = '\u001B';

interface WriterState {
  row: number;
  col: number;
  style: Cell | null;
  link: string | null;
}

// The escape sequences that turn what `previous` shows into `next`: a cursor move and an
// attribute change only where a changed cell needs one. It leaves the cursor wherever the last
// write put it, and returns '' when nothing changed.
export function renderFrameDiff(
  previous: CellBuffer,
  next: CellBuffer,
  depth: ColourDepth,
): string {
  const state: WriterState = { row: -1, col: -1, style: null, link: null };
  let out = '';

  for (let row = 0; row < next.rows; row++) {
    const changed = collectChangedCols(previous, next, row);

    for (let col = changed.indexOf(true); col !== -1; col = changed.indexOf(true, col + 1)) {
      if (state.row === row && col < state.col) {
        continue;
      }

      out += moveTo(state, next, { row, col }, depth);
      out += renderCell(state, next.get(col, row), isWide(next, col, row), depth);
    }

    out += finishLink(state);
  }

  return out.length === 0 || state.style === null || isSameStyle(state.style, BLANK_CELL)
    ? out
    : `${out}${ESC}[0m`;
}

function collectChangedCols(previous: CellBuffer, next: CellBuffer, row: number): boolean[] {
  const changed: boolean[] = [];

  for (let col = 0; col < next.cols; col++) {
    changed.push(!isSameCell(previous.get(col, row), next.get(col, row)));
  }

  // A half of a wide character cannot be redrawn alone.
  for (let col = 0; col < next.cols; col++) {
    if (changed[col] === true && next.get(col, row).ch === '' && col > 0) {
      changed[col - 1] = true;
    }

    if (changed[col] === true && isWide(next, col, row)) {
      changed[col + 1] = true;
    }
  }

  return changed;
}

function isWide(buffer: CellBuffer, col: number, row: number): boolean {
  return col + 1 < buffer.cols && buffer.get(col + 1, row).ch === '';
}

// A gap of unchanged cells this short costs fewer bytes to write over than to jump across.
const GAP_FILL_MAX = 6;

interface CellPosition {
  readonly row: number;
  readonly col: number;
}

function moveTo(
  state: WriterState,
  next: CellBuffer,
  target: CellPosition,
  depth: ColourDepth,
): string {
  const row = target.row;
  const col = target.col;
  const gap = col - state.col;

  if (state.row === row && gap === 0) {
    return '';
  }

  if (state.row === row && gap > 0 && gap <= GAP_FILL_MAX) {
    let filler = '';

    for (let fill = state.col; fill < col; fill++) {
      filler += renderCell(state, next.get(fill, row), isWide(next, fill, row), depth);
    }

    return filler;
  }

  const jump = `${finishLink(state)}${ESC}[${row + 1};${col + 1}H`;

  state.row = row;
  state.col = col;

  return jump;
}

function renderCell(
  state: WriterState,
  cell: Cell,
  isWideLead: boolean,
  depth: ColourDepth,
): string {
  if (cell.ch === '') {
    return '';
  }

  let out = '';
  const style = state.style ?? BLANK_CELL;

  if (!isSameStyle(style, cell)) {
    out += formatSGR(cell, depth, state.style === null || isSameStyle(style, BLANK_CELL));
    state.style = cell;
  }

  if (cell.link !== state.link) {
    out += finishLink(state);

    if (cell.link !== null) {
      out += `${ESC}]8;;${cell.link}${ESC}\\`;
      state.link = cell.link;
    }
  }

  state.col += isWideLead ? 2 : 1;

  return `${out}${cell.ch}`;
}

function finishLink(state: WriterState): string {
  if (state.link === null) {
    return '';
  }

  state.link = null;

  return `${ESC}]8;;${ESC}\\`;
}
