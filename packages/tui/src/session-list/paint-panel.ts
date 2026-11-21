import { BLANK_CELL } from '../compositor/blank-cell';
import { blendRGB } from '../compositor/blend-rgb';
import { dimCell } from '../compositor/dim-cell';
import { resolveColour } from '../compositor/resolve-colour';
import type { CellBuffer, RGB, TerminalFacts } from '../compositor/types';
import { splitGraphemes } from '../terminal/split-graphemes';
import { collectPanelLines } from './collect-panel-lines';
import { BLUE, CONTENT_COL, PANEL_BACKGROUND, PANEL_OPACITY, SELECTED_TINT } from './constants';
import type { ListMotion } from './pick-list-motion';
import type { PanelLine, PanelPlan } from './types';

export interface PaintOptions {
  readonly terminal: TerminalFacts;
  readonly motion: ListMotion;

  // how far the layers below move toward the terminal's background at the full dim
  readonly dimShare: number;
}

// Dims every row above the terminal's last one, then draws the panel over it. The last row is the
// fleet bar's, and stays as it is.
export function paintPanel(buffer: CellBuffer, plan: PanelPlan, options: PaintOptions): void {
  dimBackdrop(buffer, options);

  for (const [index, { line, listIndex }] of collectPanelLines(plan).entries()) {
    const row = plan.top + index;

    if (row >= buffer.rows - 1) {
      break;
    }

    const textOpacity = listIndex === null ? options.motion.frame : options.motion.row(listIndex);

    paintLine(buffer, { line, plan, row, textOpacity, edgeOpacity: options.motion.frame, options });
  }
}

function dimBackdrop(buffer: CellBuffer, options: PaintOptions): void {
  const share = options.dimShare * options.motion.dim;

  if (share <= 0) {
    return;
  }

  for (let row = 0; row < buffer.rows - 1; row++) {
    for (let col = 0; col < buffer.cols; col++) {
      buffer.set(col, row, dimCell(buffer.get(col, row), options.terminal, share));
    }
  }
}

interface LinePaint {
  readonly line: PanelLine;
  readonly plan: PanelPlan;
  readonly row: number;

  // how much of the line's text shows, from 0 to 1
  readonly textOpacity: number;

  // how much of the side borders shows, from 0 to 1
  readonly edgeOpacity: number;
  readonly options: PaintOptions;
}

function paintLine(buffer: CellBuffer, paint: LinePaint): void {
  const plan = paint.plan;
  const terminal = paint.options.terminal;
  const backgrounds: RGB[] = [];

  clearWideEdges(buffer, paint);

  for (let offset = 0; offset < plan.width; offset++) {
    const col = plan.left + offset;
    const below = buffer.get(col, paint.row);
    const shownBackground = below.inverse ? below.fg : below.bg;
    const underlying = resolveColour(shownBackground, terminal.background);

    const covered = blendRGB(
      underlying,
      PANEL_BACKGROUND,
      PANEL_OPACITY * paint.options.motion.frame,
    );

    const isTinted =
      paint.line.isSelected && offset >= CONTENT_COL && offset < plan.width - CONTENT_COL;

    const background = isTinted
      ? blendRGB(covered, BLUE, SELECTED_TINT * paint.textOpacity)
      : covered;

    backgrounds.push(background);

    buffer.set(col, paint.row, {
      ...BLANK_CELL,
      bg:
        terminal.depth === '16'
          ? { kind: 'default' }
          : { kind: 'rgb', red: background.red, green: background.green, blue: background.blue },
    });
  }

  for (const span of paint.line.spans) {
    let offset = span.col;

    // a span in the panel's first or last column is its side border, which fades with the frame
    const isEdge = span.col === 0 || span.col === plan.width - 1;
    const opacity = isEdge ? paint.edgeOpacity : paint.textOpacity;

    for (const grapheme of splitGraphemes(span.text)) {
      const background = backgrounds[offset];

      if (grapheme.width > 0 && background !== undefined && offset + grapheme.width <= plan.width) {
        const fg = blendRGB(background, span.fg, opacity);

        const cell = {
          ...BLANK_CELL,
          ch: grapheme.text,
          fg: { kind: 'rgb', red: fg.red, green: fg.green, blue: fg.blue },
          bg: buffer.get(plan.left + offset, paint.row).bg,
          bold: span.bold,
        } as const;

        buffer.set(plan.left + offset, paint.row, cell);

        // the second column of a wide grapheme holds an empty string
        if (grapheme.width === 2) {
          buffer.set(plan.left + offset + 1, paint.row, { ...cell, ch: '' });
        }
      }

      offset += grapheme.width;
    }
  }
}

// A wide grapheme below the panel can start outside an edge and end inside it, or the other way
// round. The terminal would draw half of it, so the half outside becomes a space.
function clearWideEdges(buffer: CellBuffer, paint: LinePaint): void {
  const left = paint.plan.left;
  const right = left + paint.plan.width;

  if (left > 0 && buffer.get(left, paint.row).ch === '') {
    buffer.set(left - 1, paint.row, { ...buffer.get(left - 1, paint.row), ch: ' ' });
  }

  if (right < buffer.cols && buffer.get(right, paint.row).ch === '') {
    buffer.set(right, paint.row, { ...buffer.get(right, paint.row), ch: ' ' });
  }
}
