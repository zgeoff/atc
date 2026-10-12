import type { SessionID } from '../shared/session-id';
import type { TargetAccess, TargetGrant } from './target-access';

// A session as the tree check reads it: its id, its parent if it has one,
// and the target it is bound to.
interface TreeMember extends TargetGrant {
  readonly id: SessionID;
  readonly parent: SessionID | null;
}

/**
 * Whether the access reaches every session in the tree the given session
 * belongs to: its top-level session and each sub-session of that one. A
 * session the list does not hold, or one whose parent it does not hold,
 * is out of reach.
 */
export function isTreeInReach(
  sessions: readonly TreeMember[],
  id: SessionID,
  access: TargetAccess,
): boolean {
  const session = sessions.find((x) => x.id === id);

  if (session === undefined) {
    return false;
  }

  const root = session.parent ?? session.id;
  const tree = sessions.filter((x) => x.id === root || x.parent === root);

  return tree.some((x) => x.id === root) && tree.every((x) => access.canUse(x));
}
