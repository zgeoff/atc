import { cols } from './cols';
import { boxBottom, boxDivider, boxRow, boxTop, dimRow, drawBox } from './draw-box';
import { truncate } from './truncate';
import type { Row } from './types';
import { writeOut } from './write-out';

const ESC = '\u001B';

export function getPickerWidth(): number {
  return Math.min(cols() - 4, 90);
}

export interface PickerView {
  title: string;
  items: readonly string[];
  selected: number;
  input: string;
  placeholder?: string;
  hint: string;

  dimmed?: ReadonlySet<number>;
}

export function drawPicker(view: PickerView, write: (chunk: string) => void = writeOut) {
  const width = getPickerWidth();
  const rowsList: Row[] = [boxTop(width, view.title)];
  const visible = planPickerWindow(view.items.length, view.selected);

  if (visible.start > 0) {
    rowsList.push(dimRow(width, `↑ ${visible.start} more`));
  }

  for (const [offset, item] of view.items.slice(visible.start, visible.end).entries()) {
    const index = visible.start + offset;
    const sel = index === view.selected;
    const truncated = truncate(item, width - 4);
    const dim = view.dimmed?.has(index) === true;
    const inverse = sel ? `${ESC}[7m${truncated.padEnd(width - 4)}${ESC}[0m` : truncated;
    const styled = dim ? `${ESC}[90m${inverse}${ESC}[0m` : inverse;
    const plainLen = sel ? width - 4 : truncated.length;

    rowsList.push(boxRow(width, styled, plainLen));
  }

  if (visible.end < view.items.length) {
    rowsList.push(dimRow(width, `↓ ${view.items.length - visible.end} more`));
  }

  const inputMax = width - 8;

  const inputShown =
    view.input.length <= inputMax ? view.input : `…${view.input.slice(-(inputMax - 1))}`;

  let inputStyled: string;
  let inputLen: number;

  if (inputShown === '' && view.placeholder !== undefined && view.placeholder !== '') {
    const ph = truncate(view.placeholder, width - 8);

    inputStyled = `> ${ESC}[93m█${ESC}[0m${ESC}[90m ${ph}${ESC}[0m`;
    inputLen = 2 + 1 + 1 + ph.length;
  } else {
    inputStyled = `> ${inputShown}${ESC}[93m█${ESC}[0m`;
    inputLen = 2 + inputShown.length + 1;
  }

  rowsList.push(
    boxRow(width, inputStyled, inputLen),
    boxDivider(width),
    dimRow(width, view.hint),
    boxBottom(width),
  );

  drawBox(rowsList, write);
}

interface PickerWindow {
  readonly start: number;
  readonly end: number;
}

const PICKER_WINDOW_ROWS = 10;

function planPickerWindow(count: number, selected: number): PickerWindow {
  if (count <= PICKER_WINDOW_ROWS) {
    return { start: 0, end: count };
  }

  const edgeItems = PICKER_WINDOW_ROWS - 1;

  if (selected < edgeItems) {
    return { start: 0, end: edgeItems };
  }

  const hiddenBelow = count - selected - 1;

  if (hiddenBelow <= 1) {
    return { start: count - edgeItems, end: count };
  }

  return { start: selected - edgeItems + 2, end: selected + 1 };
}
