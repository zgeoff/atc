import { LOCAL_TARGET } from '@atc/config';
import { buildTargetIdentity } from './build-target-identity';
import type { FleetEntry } from './fleet-entry';

type ReplaceableRow = Pick<FleetEntry, 'agentSessionID' | 'exited' | 'target' | 'targetIdentity'>;

export function findReplacement(
  row: ReplaceableRow,
  entries: readonly FleetEntry[],
  from: number,
): FleetEntry | undefined {
  for (let index = entries.length - 1; index >= from; index--) {
    const entry = entries[index];

    if (entry !== undefined && isReplaceableBy(row, entry)) {
      return findReplacement(entry, entries, index + 1) ?? entry;
    }
  }

  return undefined;
}

const LOCAL_TARGET_IDENTITY = buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options);

// A live row on another target stays: that target may still run its session, and atc must not forget it.
function isReplaceableBy(row: ReplaceableRow, later: ReplaceableRow): boolean {
  return (
    row.agentSessionID !== undefined &&
    row.agentSessionID === later.agentSessionID &&
    (row.exited === true ||
      ((row.target ?? LOCAL_TARGET.id) === (later.target ?? LOCAL_TARGET.id) &&
        (row.targetIdentity ?? LOCAL_TARGET_IDENTITY) ===
          (later.targetIdentity ?? LOCAL_TARGET_IDENTITY)))
  );
}
