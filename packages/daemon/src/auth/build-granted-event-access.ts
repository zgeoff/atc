import type { SessionID } from '@atcx/contract';
import type { HeldAtcAccess } from '../types';
import { buildSessionSetAccess } from './build-session-set-access';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import type { TargetAccess } from './build-target-access-from-grants';

export function buildGrantedEventAccess(
  holder: SessionID,
  held: HeldAtcAccess | null,
  isInSubtree: (id: SessionID) => boolean,
): TargetAccess {
  if (held === null || !held.scopes.includes('read')) {
    return buildTargetAccessFromGrants([]);
  }

  return buildSessionSetAccess(held.grant, (id) => id === holder || isInSubtree(id));
}
