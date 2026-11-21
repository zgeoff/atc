export interface ListWindow {
  // the lines shown, from `start` up to but not including `end`
  readonly start: number;
  readonly end: number;
}

// Picks the lines to show when the panel has room for `capacity` lines, keeping the selected line
// near the middle of the window.
export function planListWindow(
  lineCount: number,
  capacity: number,
  selectedLine: number,
): ListWindow {
  if (lineCount <= capacity) {
    return { start: 0, end: lineCount };
  }

  const centred = selectedLine - Math.floor(capacity / 2);
  const start = Math.max(0, Math.min(centred, lineCount - capacity));

  return { start, end: start + capacity };
}
