import { blendRGB } from './blend-rgb';
import { fadeBackground } from './fade-background';
import { resolveColour } from './resolve-colour';
import { toRGBColour } from './to-rgb-colour';
import type { Cell, TerminalFacts } from './types';

// Blends the cell toward the terminal's background by a share from 0 to 1. A default background
// stays default, so a transparent terminal stays transparent. At 16 colours the cell keeps its
// colours and gains SGR dim.
export function dimCell(cell: Cell, terminal: TerminalFacts, share: number): Cell {
  if (terminal.depth === '16') {
    return { ...cell, dim: true };
  }

  const fg = resolveColour(cell.fg, terminal.foreground);

  if (cell.inverse) {
    const bg = resolveColour(cell.bg, terminal.background);

    return {
      ...cell,
      inverse: false,
      fg: toRGBColour(blendRGB(bg, terminal.background, share)),
      bg: fadeBackground(toRGBColour(fg), terminal, share),
    };
  }

  return {
    ...cell,
    fg: toRGBColour(blendRGB(fg, terminal.background, share)),
    bg: fadeBackground(cell.bg, terminal, share),
  };
}
