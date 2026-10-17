export interface BoxExtent {
  readonly top: number;
  readonly height: number;
}

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
