import { BLANK_CELL } from './blank-cell';
import type { Cell, CellBuffer } from './types';

export function buildCellBuffer(cols: number, rows: number): CellBuffer {
  const cells: Cell[] = Array.from({ length: cols * rows }, () => BLANK_CELL);

  return {
    cols,
    rows,
    get: (col, row) => {
      if (col < 0 || row < 0 || col >= cols || row >= rows) {
        return BLANK_CELL;
      }

      return cells[row * cols + col] ?? BLANK_CELL;
    },
    set: (col, row, cell) => {
      if (col >= 0 && row >= 0 && col < cols && row < rows) {
        cells[row * cols + col] = cell;
      }
    },
  };
}
