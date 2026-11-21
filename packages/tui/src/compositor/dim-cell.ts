import { blendRGB } from './blend-rgb';
import { resolveColour } from './resolve-colour';
import type { Cell, Colour, RGB, TerminalFacts } from './types';

// Blends the cell toward the terminal's background by a share from 0 to 1. A default background
// stays default, so a transparent terminal stays transparent. At 16 colours the cell keeps its
// colours and gains SGR dim.
export function dimCell(cell: Cell, terminal: TerminalFacts, share: number): Cell {
  if (terminal.depth === '16') {
    return { ...cell, dim: true };
  }

  const fg = resolveColour(cell.fg, terminal.foreground);
  const bg = resolveColour(cell.bg, terminal.background);

  if (cell.inverse) {
    return {
      ...cell,
      inverse: false,
      fg: toRGBColour(blendRGB(bg, terminal.background, share)),
      bg: toRGBColour(blendRGB(fg, terminal.background, share)),
    };
  }

  return {
    ...cell,
    fg: toRGBColour(blendRGB(fg, terminal.background, share)),
    bg:
      cell.bg.kind === 'default' ? cell.bg : toRGBColour(blendRGB(bg, terminal.background, share)),
  };
}

function toRGBColour(rgb: RGB): Colour {
  return { kind: 'rgb', red: rgb.red, green: rgb.green, blue: rgb.blue };
}
