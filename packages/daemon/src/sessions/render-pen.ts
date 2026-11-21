import { isRecord } from '@atc/core';
import type { IBufferCell } from '@xterm/headless';

// What a cell and xterm's pen, its current and saved attributes, both answer.
export type Pen = Pick<
  IBufferCell,
  | 'isBold'
  | 'isDim'
  | 'isItalic'
  | 'isBlink'
  | 'isInverse'
  | 'isInvisible'
  | 'isStrikethrough'
  | 'isOverline'
  | 'isFgRGB'
  | 'isFgPalette'
  | 'getFgColor'
  | 'isBgRGB'
  | 'isBgPalette'
  | 'getBgColor'
>;

// The SGR sequence that sets the pen from a reset, with the underline style and colour.
export function renderPen(pen: Pen): string {
  const params = ['0'];

  if (pen.isBold() !== 0) {
    params.push('1');
  }

  if (pen.isDim() !== 0) {
    params.push('2');
  }

  if (pen.isItalic() !== 0) {
    params.push('3');
  }

  params.push(...renderUnderline(pen));

  if (pen.isBlink() !== 0) {
    params.push('5');
  }

  if (pen.isInverse() !== 0) {
    params.push('7');
  }

  if (pen.isInvisible() !== 0) {
    params.push('8');
  }

  if (pen.isStrikethrough() !== 0) {
    params.push('9');
  }

  if (pen.isOverline() !== 0) {
    params.push('53');
  }

  params.push(
    ...renderColour(38, pen.isFgRGB(), pen.isFgPalette(), pen.getFgColor()),
    ...renderColour(48, pen.isBgRGB(), pen.isBgPalette(), pen.getBgColor()),
    ...renderUnderlineColour(pen),
  );

  return `\u001B[${params.join(';')}m`;
}

// xterm 6 reports every linked cell as underlined with a dashed style, so the pen's own underline
// comes from the raw attribute bits: the underline flag in fg, the style in ext.
const FG_UNDERLINE = 0x10_00_00_00;
const EXT_UNDERLINE_STYLE = 0x1c_00_00_00;
const EXT_UNDERLINE_SHIFT = 26;

function renderUnderline(pen: Pen): string[] {
  const fg: unknown = Reflect.get(pen, 'fg');

  if (typeof fg !== 'number' || (fg & FG_UNDERLINE) === 0) {
    return [];
  }

  const ext = findExtendedValue(pen, '_ext');
  const style = typeof ext === 'number' ? (ext & EXT_UNDERLINE_STYLE) >> EXT_UNDERLINE_SHIFT : 1;

  return [style > 1 ? `4:${style}` : '4'];
}

function findExtendedValue(pen: Pen, key: string): unknown {
  const extended: unknown = Reflect.get(pen, 'extended');

  return isRecord(extended) ? extended[key] : undefined;
}

function renderColour(
  selector: number,
  isRGB: boolean,
  isPalette: boolean,
  value: number,
): string[] {
  if (isRGB) {
    return [`${selector};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`];
  }

  return isPalette ? [`${selector};5;${value}`] : [];
}

// The underline colour is stored with its mode in the top byte: 1 and 2 are a palette index, 3 is
// RGB, 0 is the default.
function renderUnderlineColour(pen: Pen): string[] {
  const value = findExtendedValue(pen, 'underlineColor');

  if (typeof value !== 'number') {
    return [];
  }

  const mode = value >>> 24;
  const rest = value & 0xff_ff_ff;

  if (mode === 3) {
    return [`58;2;${rest >> 16};${(rest >> 8) & 0xff};${rest & 0xff}`];
  }

  return mode === 1 || mode === 2 ? [`58;5;${rest & 0xff}`] : [];
}
