import { PINNED_GROUP_KEY } from './pinned-group-key';
import { sortSessionViews } from './sort-session-views';
import type { SortableSessionView } from './sortable-session-view';

export function sortGroupedSessionViews<
  T extends SortableSessionView & { readonly repoRoot: string },
>(list: readonly T[]): T[] {
  // the session at the top of each family; the sort puts a parent before its sub-sessions
  const owners = new Map<string, T>();
  const buckets = new Map<string, T[]>();

  for (const session of sortSessionViews(list)) {
    const owner = (session.parent === null ? undefined : owners.get(session.parent)) ?? session;

    owners.set(session.id, owner);

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
