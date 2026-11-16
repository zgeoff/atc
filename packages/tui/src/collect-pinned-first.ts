interface PinnableRow {
  readonly id: string;
  readonly parent: string | null;
  readonly pinned: boolean;
}

// The session list draws a pinned header where a run of pinned rows starts, so the pinned rows of
// every daemon must sit together, ahead of every daemon's other rows.
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
