import type { ListRow, SessionRow } from './types';

type HeaderRow = Extract<ListRow, { readonly kind: 'header' }>;

// The rows whose session names hold the typed letters, as one substring with case ignored. A
// header stays only above a session that stays, with its counts made again.
export function narrowListRows(rows: readonly ListRow[], typed: string): ListRow[] {
  if (typed === '') {
    return [...rows];
  }

  const needle = typed.toLowerCase();
  const narrowed: ListRow[] = [];
  let header: HeaderRow | null = null;
  let group: SessionRow[] = [];

  for (const row of rows) {
    if (row.kind === 'header') {
      narrowed.push(...closeGroup(header, group));

      header = row;
      group = [];
    } else if (row.session.name.toLowerCase().includes(needle)) {
      group.push(row);
    }
  }

  narrowed.push(...closeGroup(header, group));

  return narrowed;
}

function closeGroup(header: HeaderRow | null, group: readonly SessionRow[]): ListRow[] {
  if (header === null || group.length === 0) {
    return [...group];
  }

  const needYou = group.filter((row) => row.session.state === 'needs_you').length;

  return [{ ...header, count: group.length, needYou }, ...group];
}
