import { LOCAL_TARGET } from '@atc/config/local-target';
import type { FleetEntry } from '../store/fleet-entry';
import { buildTargetIdentity } from './build-target-identity';
import type { TargetGrant } from './target-access';

/**
 * The target a fleet row's session is bound to. A row that stores no
 * target ran on the implicit `local` target, under its identity.
 */
export function buildGrantFromFleetEntry(entry: FleetEntry): TargetGrant {
  return {
    target: entry.target ?? LOCAL_TARGET.id,
    targetIdentity:
      entry.targetIdentity ?? buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
  };
}
