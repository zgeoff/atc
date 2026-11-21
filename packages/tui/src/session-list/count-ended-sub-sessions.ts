import type { OverlaySessionView } from './types';

// The sub-sessions of a session that are dead and unpinned. The daemon removes those with their
// parent. The TUI cannot see each sub-session's provider, so the count may include one that the
// daemon keeps, and never leaves out one it removes.
export function countEndedSubSessions(
  session: Readonly<OverlaySessionView>,
  sessions: readonly Readonly<OverlaySessionView>[],
): number {
  return sessions.filter(
    (other) =>
      other.parent === session.id &&
      other.daemon === session.daemon &&
      !other.alive &&
      !other.pinned,
  ).length;
}
