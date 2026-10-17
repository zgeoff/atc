import { PINNED_GROUP_KEY } from './pinned-group-key';
import { sortSessionViews } from './sort-session-views';
import type { SortableSessionView } from './sortable-session-view';

// each repository's sessions gather at its best-ranked member, because the
// renderer draws a group header wherever adjacent rows change repository
export function sortGroupedSessionViews<
  T extends SortableSessionView & { readonly repoRoot: string },
>(list: readonly T[]): T[] {
  const byID = new Map(list.map((s) => [s.id, s]));
  const buckets = new Map<string, T[]>();

  for (const s of sortSessionViews(list)) {
    const owner = (s.parent === null ? undefined : byID.get(s.parent)) ?? s;
    const key = owner.pinned ? PINNED_GROUP_KEY : owner.repoRoot;
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [s]);
    } else {
      bucket.push(s);
    }
  }

  return [...buckets.values()].flat();
}
