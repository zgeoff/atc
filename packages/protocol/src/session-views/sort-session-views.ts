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

  const listed = new Set(ranked.map((session) => session.id));

  const sorted: T[] = [];

  for (const session of ranked) {
    if (session.parent !== null && listed.has(session.parent)) {
      continue;
    }

    sorted.push(session, ...ranked.filter((child) => child.parent === session.id));
  }

  return sorted;
}
