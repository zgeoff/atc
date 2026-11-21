import { isRecord } from '@atc/core';
import type { IBufferCell, Terminal } from '@xterm/headless';
import { BLANK_CELL } from '../compositor/blank-cell';
import type { Cell, Colour, Underline } from '../compositor/types';

// xterm's public cell API exposes neither the underline style nor a hyperlink, so both come from
// the cell's extended attributes.
export function readXtermCell(term: Terminal, cell: IBufferCell): Cell {
  const width = cell.getWidth();

  if (width === 0) {
    return { ...BLANK_CELL, ch: '' };
  }

  const extended = readMember(cell, 'extended');
  const chars = cell.getChars();

  return {
    ch: chars === '' || cell.isInvisible() !== 0 ? ' ' : chars,
    fg: readColour(cell, 'fg'),
    bg: readColour(cell, 'bg'),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: readUnderline(cell, extended),
    strikethrough: cell.isStrikethrough() !== 0,
    inverse: cell.isInverse() !== 0,
    link: readLink(term, extended),
  };
}

function readColour(cell: IBufferCell, ground: 'fg' | 'bg'): Colour {
  const isDefault = ground === 'fg' ? cell.isFgDefault() : cell.isBgDefault();

  if (isDefault) {
    return { kind: 'default' };
  }

  const isRGB = ground === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const value = ground === 'fg' ? cell.getFgColor() : cell.getBgColor();

  if (isRGB) {
    return {
      kind: 'rgb',
      red: (value >> 16) & 0xff,
      green: (value >> 8) & 0xff,
      blue: value & 0xff,
    };
  }

  return { kind: 'palette', index: value };
}

// xterm 6 reports every cell of an OSC 8 link as underlined with a dashed style, so the agent's
// own underline comes from the raw attribute bits: the underline flag in fg, the style in ext.
const FG_UNDERLINE = 0x10_00_00_00;
const EXT_UNDERLINE_STYLE = 0x1c_00_00_00;
const EXT_UNDERLINE_SHIFT = 26;

function readUnderline(cell: IBufferCell, extended: unknown): Underline {
  const fg = readMember(cell, 'fg');

  if (typeof fg !== 'number' || (fg & FG_UNDERLINE) === 0) {
    return 'none';
  }

  const ext = readMember(extended, '_ext');
  const style = typeof ext === 'number' ? (ext & EXT_UNDERLINE_STYLE) >> EXT_UNDERLINE_SHIFT : 1;

  if (style === 2) {
    return 'double';
  }

  return style === 3 ? 'curly' : 'single';
}

function readLink(term: Terminal, extended: unknown): string | null {
  const urlID = readMember(extended, 'urlId');

  if (typeof urlID !== 'number' || urlID === 0) {
    return null;
  }

  const links = readMember(Reflect.get(term, '_core'), '_oscLinkService');
  const getLinkData = readMember(links, 'getLinkData');

  if (typeof getLinkData !== 'function') {
    return null;
  }

  const data: unknown = Reflect.apply(getLinkData, links, [urlID]);
  const uri = readMember(data, 'uri');

  return typeof uri === 'string' ? uri : null;
}

export function readMember(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
