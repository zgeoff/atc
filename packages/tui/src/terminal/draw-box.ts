import { ansi } from '@atc/core';
import { planVacatedRows } from '../overlay/plan-vacated-rows';
import type { BoxExtent } from '../overlay/plan-vacated-rows';
import { cols } from './cols';
import { rows } from './rows';
import { truncate } from './truncate';

const ESC = '\u001B';

// All box rows are built as {styled, plainWidth} pairs so centering and edge
// alignment never depend on ANSI-stripped length math at draw time.
export interface Row {
  readonly styled: string;
  readonly width: number;
}

// The extent of the last box drawn, so the next draw can erase the rows a
// shrinking or shifting box leaves behind. Erasing an already-blank row is a
// no-op, so a stale extent after a full clear is harmless.
let lastBoxExtent: BoxExtent | null = null;

export function boxTop(width: number, title: string): Row {
  const framedTitle = ` ${title} `;

  return {
    styled: `┌${framedTitle}${'─'.repeat(Math.max(0, width - 2 - framedTitle.length))}┐`,
    width,
  };
}

export function dimRow(width: number, text: string): Row {
  const truncated = truncate(text, width - 4);

  return boxRow(width, `${ESC}[90m${truncated}${ESC}[0m`, truncated.length);
}

export function boxRow(width: number, styledContent: string, contentPlainLen: number): Row {
  const pad = ' '.repeat(Math.max(0, width - 4 - contentPlainLen));

  return { styled: `│ ${styledContent}${pad} │`, width };
}

export function boxDivider(width: number): Row {
  return { styled: `├${'─'.repeat(width - 2)}┤`, width };
}

export function boxBottom(width: number): Row {
  return { styled: `└${'─'.repeat(width - 2)}┘`, width };
}

export function drawBox(rowsList: readonly Row[], write: (chunk: string) => void) {
  const boxWidth = Math.max(...rowsList.map((row) => row.width));
  const top = Math.max(1, Math.floor((rows() - 1 - rowsList.length) / 2));
  const left = Math.max(1, Math.floor((cols() - boxWidth) / 2));
  const extent: BoxExtent = { top, height: rowsList.length };
  let buf = ansi.hideCursor;

  for (const row of planVacatedRows(lastBoxExtent, extent)) {
    buf += `${ansi.moveTo(row, 1)}${ESC}[2K`;
  }

  lastBoxExtent = extent;

  for (const [index, row] of rowsList.entries()) {
    buf += ansi.moveTo(top + index, left) + row.styled;
  }

  write(buf);
}
