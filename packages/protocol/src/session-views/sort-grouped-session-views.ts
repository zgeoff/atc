import { PINNED_GROUP_KEY } from './pinned-group-key';
import { sortSessionViews } from './sort-session-views';
import type { SortableSessionView } from './sortable-session-view';

// each repository's sessions gather at its best-ranked member, because the
// renderer draws a group header wherever adjacent rows change repository
export function sortGroupedSessionViews<
  T extends SortableSessionView & { readonly repoRoot: string },
>(list: readonly T[]): T[] {
  const byID = new Map(list.map((session) => [session.id, session]));
  const buckets = new Map<string, T[]>();

  for (const session of sortSessionViews(list)) {
    const owner = (session.parent === null ? undefined : byID.get(session.parent)) ?? session;
    const key = owner.pinned ? PINNED_GROUP_KEY : owner.repoRoot;
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [session]);
    } else {
      bucket.push(session);
    }
  }

  return [...buckets.values()].flat();
}
