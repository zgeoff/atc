import { LOCAL_TARGET } from '@atc/config';
import { buildTargetIdentity } from '@atc/store';
import type { FleetEntry } from '@atc/store';
import type { TargetGrant } from './build-target-access-from-grants';

export function buildGrantFromFleetEntry(entry: FleetEntry): TargetGrant {
  return {
    target: entry.target ?? LOCAL_TARGET.id,
    targetIdentity:
      entry.targetIdentity ?? buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
  };
}
