import { LOCAL_TARGET } from '@atc/config';
import { buildTargetIdentity } from './build-target-identity';
import type { FleetEntry } from './fleet-entry';

type ReplaceableRow = Pick<FleetEntry, 'agentSessionID' | 'exited' | 'target' | 'targetIdentity'>;

// The entry that takes the place of a row written before entries[from], or
// undefined when the row stays. Replacement chains to the last later entry,
// so the result is always an entry the fleet keeps.
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

// A row without a target restores on the `local` target, and a row without
// an identity restores under the identity of the `local` target.
const LOCAL_TARGET_IDENTITY = buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options);

// Whether a later row that holds the same agent session id takes this row's
// place. A live row on another target stays: that target may still run its
// session, and atc must not forget it.
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
