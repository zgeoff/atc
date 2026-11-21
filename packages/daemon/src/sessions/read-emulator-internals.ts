import { isRecord } from '@atc/core';
import type { Terminal } from '@xterm/headless';
import type { Pen } from './render-pen';

export interface ScrollRegion {
  readonly top: number;
  readonly bottom: number;
}

export interface BufferInternals {
  readonly region: ScrollRegion | null;

  // the cursor column, which is the column count while a wrap is pending at the last column
  readonly cursorX: number;

  // what DECSC saved: the column, the row in the visible screen, and the pen
  readonly savedX: number;
  readonly savedRow: number;
  readonly savedPen: Pen | null;

  // the columns that hold a tab stop
  readonly tabStops: readonly number[];
}

export interface CursorShape {
  readonly style: 'block' | 'underline' | 'bar';
  readonly isBlinking: boolean;
}

export interface EmulatorInternals {
  readonly normal: BufferInternals;
  readonly alternate: BufferInternals;
  readonly isCursorHidden: boolean;
  readonly cursorShape: CursorShape | null;
  readonly pen: Pen | null;

  // the active charset slot, G0 to G3, and which slots hold DEC line drawing
  readonly charsetLevel: number;
  readonly lineDrawingSlots: readonly number[];
}

// xterm's public API exposes none of these, and the serialize addon omits them all.
export function readEmulatorInternals(term: Terminal): EmulatorInternals {
  const core: unknown = Reflect.get(term, '_core');
  const buffers = findMember(core, 'buffers');
  const coreService = findMember(core, 'coreService');
  const charsets = findMember(core, '_charsetService');
  const level = findMember(charsets, 'glevel');
  const slots = findMember(charsets, '_charsets');
  const pen = findMember(findMember(core, '_inputHandler'), '_curAttrData');

  return {
    normal: readBuffer(findMember(buffers, 'normal'), term),
    alternate: readBuffer(findMember(buffers, 'alt'), term),
    isCursorHidden: findMember(coreService, 'isCursorHidden') === true,
    cursorShape: readCursorShape(findMember(coreService, 'decPrivateModes')),
    pen: isPen(pen) ? pen : null,
    charsetLevel: typeof level === 'number' ? level : 0,
    lineDrawingSlots: Array.isArray(slots)
      ? [0, 1, 2, 3].filter((slot) => isLineDrawing(slots[slot]))
      : [],
  };
}

function findMember(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readBuffer(buffer: unknown, term: Terminal): BufferInternals {
  const ybase = readNumber(buffer, 'ybase');
  const savedPen = findMember(buffer, 'savedCurAttrData');
  const tabs = findMember(buffer, 'tabs');

  return {
    region: readRegion(buffer, term.rows),
    cursorX: readNumber(buffer, 'x'),
    savedX: Math.min(readNumber(buffer, 'savedX'), term.cols - 1),
    savedRow: Math.max(0, readNumber(buffer, 'savedY') - ybase),
    savedPen: isPen(savedPen) ? savedPen : null,
    tabStops: isRecord(tabs)
      ? Object.keys(tabs)
          .filter((col) => tabs[col] === true)
          .map(Number)
          .toSorted((left, right) => left - right)
      : [],
  };
}

function readNumber(value: unknown, key: string): number {
  const member = findMember(value, key);

  return typeof member === 'number' ? member : 0;
}

function readRegion(buffer: unknown, rows: number): ScrollRegion | null {
  if (!isRecord(buffer)) {
    return null;
  }

  const top = buffer['scrollTop'];
  const bottom = buffer['scrollBottom'];

  if (typeof top !== 'number' || typeof bottom !== 'number') {
    return null;
  }

  return top === 0 && bottom === rows - 1 ? null : { top, bottom };
}

const PEN_METHODS = [
  'isBold',
  'isDim',
  'isItalic',
  'isBlink',
  'isInverse',
  'isInvisible',
  'isStrikethrough',
  'isOverline',
  'isFgRGB',
  'isFgPalette',
  'getFgColor',
  'isBgRGB',
  'isBgPalette',
  'getBgColor',
] as const;

function isPen(value: unknown): value is Pen {
  return (
    typeof value === 'object' &&
    value !== null &&
    PEN_METHODS.every((method) => typeof Reflect.get(value, method) === 'function')
  );
}

function readCursorShape(modes: unknown): CursorShape | null {
  const style = findMember(modes, 'cursorStyle');

  if (style !== 'block' && style !== 'underline' && style !== 'bar') {
    return null;
  }

  return { style, isBlinking: findMember(modes, 'cursorBlink') === true };
}

// xterm keeps a charset as a map of the bytes it replaces; DEC line drawing draws `q` as `─`.
function isLineDrawing(charset: unknown): boolean {
  return findMember(charset, 'q') === '─';
}
