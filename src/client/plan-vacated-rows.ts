export interface BoxExtent {
  readonly top: number;
  readonly height: number;
}

/**
 * The screen rows the previous box covered that the next one does not. A
 * centered box shifts and shrinks as its row count changes, so a redraw
 * erases these rows first — otherwise the old box's edges linger as ghost
 * lines above and below the new one.
 */
export function planVacatedRows(prev: BoxExtent | null, next: BoxExtent): number[] {
  if (prev === null) {
    return [];
  }

  const vacated: number[] = [];

  for (let row = prev.top; row < prev.top + prev.height; row++) {
    if (row < next.top || row >= next.top + next.height) {
      vacated.push(row);
    }
  }

  return vacated;
}
