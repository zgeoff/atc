import type { SessionID } from '@atcx/contract';

interface SubtreeMember {
  readonly id: SessionID;
  readonly parent: SessionID | null;
  readonly spawner: SessionID | null;
}

// A spawn from a sub-session lands beside it under the top-level parent, so
// the subtree follows the spawner link as well as the parent link.
export function collectSessionSubtree(
  sessions: readonly SubtreeMember[],
  root: SessionID,
): ReadonlySet<SessionID> {
  const reached = new Set<SessionID>([root]);

  let grew = true;

  while (grew) {
    grew = false;

    for (const session of sessions) {
      if (
        !reached.has(session.id) &&
        ((session.parent !== null && reached.has(session.parent)) ||
          (session.spawner !== null && reached.has(session.spawner)))
      ) {
        reached.add(session.id);

        grew = true;
      }
    }
  }

  reached.delete(root);

  return reached;
}
