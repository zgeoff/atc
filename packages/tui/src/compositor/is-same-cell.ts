import type { Cell, Colour } from './types';

export function isSameCell(left: Cell, right: Cell): boolean {
  return left.ch === right.ch && left.link === right.link && isSameStyle(left, right);
}

export function isSameStyle(left: Cell, right: Cell): boolean {
  return (
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strikethrough === right.strikethrough &&
    left.inverse === right.inverse &&
    isSameColour(left.fg, right.fg) &&
    isSameColour(left.bg, right.bg)
  );
}

function isSameColour(left: Colour, right: Colour): boolean {
  if (left.kind === 'default' || right.kind === 'default') {
    return left.kind === right.kind;
  }

  if (left.kind === 'palette' && right.kind === 'palette') {
    return left.index === right.index;
  }

  return (
    left.kind === 'rgb' &&
    right.kind === 'rgb' &&
    left.red === right.red &&
    left.green === right.green &&
    left.blue === right.blue
  );
}
