import { match } from 'ts-pattern';
import { BLANK_CELL } from '../compositor/blank-cell';
import type { CellBuffer, Colour, FrameInfo, Layer, RGB } from '../compositor/types';
import { splitGraphemes } from '../terminal/split-graphemes';
import { buildBitmapCoverage } from './build-bitmap-coverage';
import { buildHomeLayout } from './build-home-layout';
import { buildOutlineCoverage } from './build-outline-coverage';
import { buildWordmarkCells } from './build-wordmark-cells';
import type { WordmarkCell } from './build-wordmark-cells';
import { AMBER, KEY_BLUE, OUTLINE_SIZES, WORDMARK_TOP } from './constants';
import { pickWordmark } from './pick-wordmark';
import type { Coverage, HomeInput, HomeRun, HomeTone, Wordmark } from './types';

export interface HomeLayerDeps {
  readonly readInput: () => HomeInput;
}

// Home as a layer of its own: the wordmark, the fleet line and the keys, over the terminal's own
// background. It never animates, so it asks for no frames; the frames that the fleet and the
// window ask for redraw it.
export function createHomeLayer(deps: HomeLayerDeps): Layer {
  const coverages = new Map<string, Coverage>();

  const readCoverage = (wordmark: Wordmark): Coverage | null =>
    match(wordmark)
      .with({ kind: 'text' }, () => null)
      .with({ kind: 'bitmap' }, () => {
        const known = coverages.get('bitmap') ?? buildBitmapCoverage();

        coverages.set('bitmap', known);

        return known;
      })
      .with({ kind: 'outline' }, (outline) => {
        const known =
          coverages.get(outline.size) ?? buildOutlineCoverage(OUTLINE_SIZES[outline.size]);

        coverages.set(outline.size, known);

        return known;
      })
      .exhaustive();

  return {
    draw: (buffer: CellBuffer, frame: FrameInfo) => {
      const wordmark = pickWordmark(frame);
      const coverage = readCoverage(wordmark);

      const wordmarkSize =
        coverage === null
          ? { cols: 3, rows: 1 }
          : { cols: coverage[0]?.length ?? 0, rows: coverage.length / 2 };

      const layout = buildHomeLayout(frame, wordmark, wordmarkSize, deps.readInput());

      if (coverage !== null) {
        paintWordmark(
          buffer,
          buildWordmarkCells(coverage, frame.terminal.background, frame.terminal.depth),
          layout.wordmarkAt,
        );
      }

      for (const run of layout.runs) {
        paintRun(buffer, run);
      }
    },

    nextFrameAt: () => null,
  };
}

interface Point {
  readonly col: number;
  readonly row: number;
}

function paintWordmark(
  buffer: CellBuffer,
  cells: readonly (readonly WordmarkCell[])[],
  at: Point,
): void {
  for (const [rowIndex, row] of cells.entries()) {
    for (const [colIndex, cell] of row.entries()) {
      if (cell.fg !== null) {
        buffer.set(at.col + colIndex, at.row + rowIndex, {
          ...BLANK_CELL,
          ch: cell.ch,
          fg: toColour(cell.fg),
          bg: cell.bg === null ? BLANK_CELL.bg : toColour(cell.bg),
        });
      }
    }
  }
}

function toColour(colour: RGB): Colour {
  return { kind: 'rgb', ...colour };
}

function paintRun(buffer: CellBuffer, run: HomeRun): void {
  const style = { ...BLANK_CELL, fg: readToneColour(run.tone), bold: run.bold, dim: run.dim };
  let col = run.col;

  for (const grapheme of splitGraphemes(run.text)) {
    if (grapheme.width > 0) {
      buffer.set(col, run.row, { ...style, ch: grapheme.text });
    }

    // the second column of a wide grapheme holds an empty string
    if (grapheme.width === 2) {
      buffer.set(col + 1, run.row, { ...style, ch: '' });
    }

    col += grapheme.width;
  }
}

function readToneColour(tone: HomeTone): Colour {
  return match(tone)
    .with('plain', () => ({ kind: 'default' as const }))
    .with('mark', () => toColour(WORDMARK_TOP))
    .with('amber', () => toColour(AMBER))
    .with('blue', () => toColour(KEY_BLUE))
    .exhaustive();
}
