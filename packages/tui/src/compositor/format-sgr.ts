import { quantiseColour } from './quantise-colour';
import type { Cell, Colour, ColourDepth } from './types';

const ESC = '\u001B';

// The full attribute state of a cell, so the writer never tracks which attributes are on. A
// reset opens it, unless the terminal is known to hold the plain style. The colours and the
// attributes go in sequences of their own. Blink and overline are dropped.
export function formatSGR(cell: Cell, depth: ColourDepth, isFromPlain: boolean): string {
  const colours = [
    ...formatColour(quantiseColour(cell.fg, depth), 'fg'),
    ...formatColour(quantiseColour(cell.bg, depth), 'bg'),
  ];

  const attributes = [
    ...(cell.bold ? ['1'] : []),
    ...(cell.dim ? ['2'] : []),
    ...(cell.italic ? ['3'] : []),
    ...formatUnderline(cell.underline),
    ...(cell.inverse ? ['7'] : []),
    ...(cell.strikethrough ? ['9'] : []),
  ];

  const reset = isFromPlain ? '' : `${ESC}[0m`;
  const colour = colours.length === 0 ? '' : `${ESC}[${colours.join(';')}m`;
  const attribute = attributes.length === 0 ? '' : `${ESC}[${attributes.join(';')}m`;

  return `${reset}${colour}${attribute}`;
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

function formatUnderline(underline: Cell['underline']): string[] {
  if (underline === 'single') {
    return ['4'];
  }

  if (underline === 'double') {
    return ['21'];
  }

  return underline === 'curly' ? ['4:3'] : [];
}
