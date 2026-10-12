import { PINNED_GROUP_KEY } from './pinned-group-key';
import { sortSessionViews } from './sort-session-views';
import type { SortableSessionView } from './sortable-session-view';

// Overlay display order for the grouped view: the flat sort with each
// repository's sessions pulled together at the position of its best-ranked
// member, so the renderer's adjacency-based headers appear once per group.
// Pinned sessions form their own leading group. A sub-session keys by its
// parent, so a set never splits across groups.
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
