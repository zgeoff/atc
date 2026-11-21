import type { SessionViewState } from './session-state';
import type { SortableSessionView } from './sortable-session-view';

export function sortSessionViews<T extends SortableSessionView>(list: readonly T[]): T[] {
  const rank: Record<SessionViewState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
    unknown: 4,
  };

  const ranked = [...list].toSorted((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const recency = right.lastAttachedAt - left.lastAttachedAt || right.createdAt - left.createdAt;

    return left.pinned ? recency : rank[left.state] - rank[right.state] || recency;
  });

  const byID = new Map(ranked.map((session) => [session.id, session]));

  const roots = ranked.filter((session) => isTopLevel(session, byID));

  const isRoot = new Set(roots);

  const sorted: T[] = [];

  const pushFamily = (session: T): void => {
    sorted.push(session);

    for (const child of ranked) {
      if (child.parent === session.id && !isRoot.has(child)) {
        pushFamily(child);
      }
    }
  };

  for (const root of roots) {
    pushFamily(root);
  }

  return sorted;
}

// A session lists at the top level when it has no listed parent, or when its parent chain loops
// back to it, since then no ancestor of it reaches the top level.
function isTopLevel<T extends SortableSessionView>(
  session: T,
  byID: ReadonlyMap<string, T>,
): boolean {
  const seen = new Set<string>();

  let current: T | undefined = session;

  while (current?.parent !== null && current !== undefined) {
    seen.add(current.id);

    current = byID.get(current.parent);

    if (current?.id === session.id) {
      return true;
    }

    if (current !== undefined && seen.has(current.id)) {
      return false;
    }
  }

  return session.parent === null || !byID.has(session.parent);
}
