import { quantiseColour } from './quantise-colour';
import type { Cell, Colour, ColourDepth } from './types';

const ESC = '\u001B';

// The full attribute state of a cell, from a reset, so the writer never tracks which attributes
// are on. Blink and overline are dropped.
export function formatSGR(cell: Cell, depth: ColourDepth): string {
  const params = [
    '0',
    ...(cell.bold ? ['1'] : []),
    ...(cell.dim ? ['2'] : []),
    ...(cell.italic ? ['3'] : []),
    ...formatUnderline(cell.underline),
    ...(cell.inverse ? ['7'] : []),
    ...(cell.strikethrough ? ['9'] : []),
    ...formatColour(quantiseColour(cell.fg, depth), 'fg'),
    ...formatColour(quantiseColour(cell.bg, depth), 'bg'),
  ];

  return `${ESC}[${params.join(';')}m`;
}

function formatUnderline(underline: Cell['underline']): string[] {
  if (underline === 'single') {
    return ['4'];
  }

  if (underline === 'double') {
    return ['21'];
  }

  return underline === 'curly' ? ['4:3'] : [];
}

function formatColour(colour: Colour, ground: 'fg' | 'bg'): string[] {
  if (colour.kind === 'default') {
    return [];
  }

  const base = ground === 'fg' ? 30 : 40;

  if (colour.kind === 'rgb') {
    return [`${base + 8}`, '2', `${colour.red}`, `${colour.green}`, `${colour.blue}`];
  }

  if (colour.index < 8) {
    return [`${base + colour.index}`];
  }

  if (colour.index < 16) {
    return [`${base + 60 + colour.index - 8}`];
  }

  return [`${base + 8}`, '5', `${colour.index}`];
}
