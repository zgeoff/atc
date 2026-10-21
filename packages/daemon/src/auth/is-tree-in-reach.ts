import type { SessionID } from '@atc/core';
import type { TargetAccess, TargetGrant } from './build-target-access-from-grants';

// A session as the tree check reads it: its id, its parent if it has one,
// and the target it is bound to.
interface TreeMember extends TargetGrant {
  readonly id: SessionID;
  readonly parent: SessionID | null;
}

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

  // a session whose parent the list does not hold is out of reach
  return tree.some((x) => x.id === root) && tree.every((x) => access.canUse(x));
}
