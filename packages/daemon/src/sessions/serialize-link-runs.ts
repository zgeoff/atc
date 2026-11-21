import { isRecord } from '@atc/core';
import type { IBuffer, IBufferCell, Terminal } from '@xterm/headless';
import { findCellLink } from './find-cell-link';
import { renderPen } from './render-pen';

const CLOSE_LINK = '\u001B]8;;\u0007';

// The serialize addon drops OSC 8, the underline styles and the underline colour, so each run of
// cells with any of them is written again with its own attributes. The cursor and pen end wherever
// the last run ended, so the caller places both afterwards.
export function serializeLinkRuns(term: Terminal, buffer: IBuffer): string {
  let out = '';

  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    let openLink: string | null = null;
    let isInRun = false;

    for (let col = 0; col < term.cols; col++) {
      const cell = line?.getCell(col);

      // the second half of a wide grapheme goes with its first half
      if (cell === undefined || cell.getWidth() === 0) {
        continue;
      }

      const link = findCellLink(term, cell);

      if (link === null && !hasExtendedUnderline(cell)) {
        out += openLink === null ? '' : CLOSE_LINK;
        openLink = null;
        isInRun = false;
        continue;
      }

      if (!isInRun) {
        out += `\u001B[${row + 1};${col + 1}H`;
        isInRun = true;
      }

      if (link !== openLink) {
        out += openLink === null ? '' : CLOSE_LINK;
        out += link === null ? '' : `\u001B]8;;${link}\u0007`;
        openLink = link;
      }

      out += `${renderPen(cell)}${cell.getChars() === '' ? ' ' : cell.getChars()}`;
    }

    out += openLink === null ? '' : CLOSE_LINK;
  }

  return out === '' ? '' : `${out}\u001B[0m`;
}

const EXT_UNDERLINE_STYLE = 0x1c_00_00_00;
const EXT_UNDERLINE_SHIFT = 26;

// a double, curly, dotted or dashed underline, or an underline colour
function hasExtendedUnderline(cell: IBufferCell): boolean {
  const extended: unknown = Reflect.get(cell, 'extended');

  if (!isRecord(extended)) {
    return false;
  }

  const ext = extended['_ext'];
  const colour = extended['underlineColor'];
  const style = typeof ext === 'number' ? (ext & EXT_UNDERLINE_STYLE) >> EXT_UNDERLINE_SHIFT : 0;

  return style > 1 || (typeof colour === 'number' && colour >>> 24 !== 0);
}
