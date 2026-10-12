import type { SessionState } from './session-state';
import type { SortableSessionView } from './sortable-session-view';

// Overlay order: pinned sessions first in most-recently-attached order, then
// everyone else by urgency — who needs you, finished turns, busy, dead —
// with most-recently-attached breaking ties inside each state. A
// sub-session sits directly under its parent, ranked among its siblings
// alone, so its attention never moves the parent's row; a sub-session whose
// parent is not listed ranks as a top-level row.
export function sortSessionViews<T extends SortableSessionView>(list: readonly T[]): T[] {
  const rank: Record<SessionState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
  };

  const ranked = [...list].toSorted((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }

    const recency = b.lastAttachedAt - a.lastAttachedAt || b.createdAt - a.createdAt;

    return a.pinned ? recency : rank[a.state] - rank[b.state] || recency;
  });

  const listed = new Set(ranked.map((s) => s.id));

  const sorted: T[] = [];

  for (const s of ranked) {
    if (s.parent !== null && listed.has(s.parent)) {
      continue;
    }

    sorted.push(s, ...ranked.filter((child) => child.parent === s.id));
  }

  return sorted;
}
