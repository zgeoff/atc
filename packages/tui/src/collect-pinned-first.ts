interface PinnableRow {
  readonly id: string;
  readonly parent: string | null;
  readonly pinned: boolean;
}

// Joins the sorted rows of each daemon with the pinned rows of every daemon first, as one
// daemon's sort puts its own pinned rows first. A sub-session goes with its parent's pin.
export function collectPinnedFirst<T extends PinnableRow>(fleets: readonly (readonly T[])[]): T[] {
  return [
    ...fleets.flatMap((rows) => rows.filter((row) => isPinnedRow(row, rows))),
    ...fleets.flatMap((rows) => rows.filter((row) => !isPinnedRow(row, rows))),
  ];
}

function isPinnedRow<T extends PinnableRow>(row: T, rows: readonly T[]): boolean {
  const parent = rows.find((candidate) => candidate.id === row.parent);

  return (parent ?? row).pinned;
}
