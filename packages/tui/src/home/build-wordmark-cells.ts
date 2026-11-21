import { blendRGB } from '../compositor/blend-rgb';
import { quantiseColour } from '../compositor/quantise-colour';
import type { ColourDepth, RGB } from '../compositor/types';
import { WORDMARK_BASE, WORDMARK_TOP } from './constants';
import type { Coverage } from './types';

// One cell of a wordmark. A null colour leaves the terminal's own.
export interface WordmarkCell {
  readonly ch: string;
  readonly fg: RGB | null;
  readonly bg: RGB | null;
}

// Turns pixel coverage into cells, two pixels to a cell: `▀` for a top pixel, `▄` for a bottom
// one, and `▀` over a background for both. The colour runs from the first lit pixel row to the
// last, and a part-covered pixel blends toward the terminal's background.
export function buildWordmarkCells(
  coverage: Coverage,
  background: RGB,
  depth: ColourDepth,
): readonly (readonly WordmarkCell[])[] {
  const height = coverage.length;
  const litRows = coverage.flatMap((row, index) => (row.some((share) => share > 0) ? [index] : []));
  const firstRow = litRows[0] ?? 0;
  const span = (litRows.at(-1) ?? 0) - firstRow;

  const toPixel = (row: number, col: number): RGB | null => {
    const share = coverage[row]?.[col] ?? 0;

    if (share === 0) {
      return null;
    }

    const rowShare = span < 1 ? 0 : (row - firstRow) / span;
    const pixel = blendRGB(background, blendRGB(WORDMARK_TOP, WORDMARK_BASE, rowShare), share);

    return isPaletteBlack(pixel, depth) ? null : pixel;
  };

  const buildRow = (cellRow: number): WordmarkCell[] =>
    Array.from({ length: coverage[0]?.length ?? 0 }, (_, col) =>
      buildCell(toPixel(cellRow * 2, col), toPixel(cellRow * 2 + 1, col)),
    );

  return Array.from({ length: height / 2 }, (_, cellRow) => buildRow(cellRow));
}

// A faint pixel over a dark background lands on the palette's black, which paints a black cell
// over the terminal's own background colour.
function isPaletteBlack(pixel: RGB, depth: ColourDepth): boolean {
  const shown = quantiseColour({ kind: 'rgb', ...pixel }, depth);

  return shown.kind === 'palette' && shown.index === 0;
}

function buildCell(top: RGB | null, bottom: RGB | null): WordmarkCell {
  if (top !== null) {
    return { ch: '▀', fg: top, bg: bottom };
  }

  return bottom === null ? { ch: ' ', fg: null, bg: null } : { ch: '▄', fg: bottom, bg: null };
}
