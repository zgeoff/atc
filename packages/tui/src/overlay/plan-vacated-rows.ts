export interface BoxExtent {
  readonly top: number;
  readonly height: number;
}

export function planVacatedRows(previous: BoxExtent | null, next: BoxExtent): number[] {
  if (previous === null) {
    return [];
  }

  const vacated: number[] = [];

  for (let row = previous.top; row < previous.top + previous.height; row++) {
    if (row < next.top || row >= next.top + next.height) {
      vacated.push(row);
    }
  }

  return vacated;
}
