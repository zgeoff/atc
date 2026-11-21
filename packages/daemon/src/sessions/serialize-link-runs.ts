import { isRecord } from '@atc/core';
import type { IBuffer, IBufferCell, Terminal } from '@xterm/headless';
import { findCellLink } from './find-cell-link';

// The serialize addon drops OSC 8, so each run of linked cells in the visible rows is written
// again under its link, with the cells' own attributes. It leaves the cursor and pen wherever
// the last run ended, so the caller places the cursor afterwards.
export function serializeLinkRuns(term: Terminal, buffer: IBuffer): string {
  let out = '';

  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    let runLink: string | null = null;

    for (let col = 0; col < term.cols; col++) {
      const cell = line?.getCell(col);
      const link = cell === undefined ? null : findCellLink(term, cell);

      // the second half of a wide grapheme carries no link of its own
      if (cell?.getWidth() === 0 && runLink !== null) {
        continue;
      }

      if (link !== runLink) {
        out += runLink === null ? '' : '\u001B]8;;\u0007';
        out += link === null ? '' : `\u001B[${row + 1};${col + 1}H\u001B]8;;${link}\u0007`;
        runLink = link;
      }

      if (cell !== undefined && link !== null) {
        out += `${renderPen(cell)}${cell.getChars() === '' ? ' ' : cell.getChars()}`;
      }
    }

    out += runLink === null ? '' : '\u001B]8;;\u0007';
  }

  return out === '' ? '' : `${out}\u001B[0m`;
}

function renderPen(cell: IBufferCell): string {
  const params = ['0'];

  if (cell.isBold() !== 0) {
    params.push('1');
  }

  if (cell.isDim() !== 0) {
    params.push('2');
  }

  if (cell.isItalic() !== 0) {
    params.push('3');
  }

  if (cell.isUnderline() !== 0) {
    params.push(pickUnderlineParam(cell));
  }

  if (cell.isBlink() !== 0) {
    params.push('5');
  }

  if (cell.isInverse() !== 0) {
    params.push('7');
  }

  if (cell.isInvisible() !== 0) {
    params.push('8');
  }

  if (cell.isStrikethrough() !== 0) {
    params.push('9');
  }

  if (cell.isOverline() !== 0) {
    params.push('53');
  }

  params.push(
    ...renderColour(38, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()),
    ...renderColour(48, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()),
    ...renderUnderlineColour(cell),
  );

  return `\u001B[${params.join(';')}m`;
}

function pickUnderlineParam(cell: IBufferCell): string {
  const style = findExtendedValue(cell, 'underlineStyle');

  return typeof style === 'number' && style > 1 ? `4:${style}` : '4';
}

function findExtendedValue(cell: IBufferCell, key: string): unknown {
  const extended = Reflect.get(cell, 'extended');
  const value: unknown = isRecord(extended) ? extended[key] : undefined;

  return value;
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
function renderUnderlineColour(cell: IBufferCell): string[] {
  const value = findExtendedValue(cell, 'underlineColor');

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
