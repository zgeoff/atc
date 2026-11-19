import type { SessionID } from '@atcx/contract';
import type { TargetAccess, TargetGrant } from './build-target-access-from-grants';

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

  // An atc grant reaches sessions whose trees can span targets the caller may not spawn on,
  // such as the parent's own, so the target check does not apply.
  if (access.canReach !== null) {
    return access.canReach(id);
  }

  const root = session.parent ?? session.id;
  const tree = sessions.filter((x) => x.id === root || x.parent === root);

  return tree.some((x) => x.id === root) && tree.every((x) => access.canUse(x));
}
