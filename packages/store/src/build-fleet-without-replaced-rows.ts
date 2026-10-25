import type { SessionID } from '@atcx/contract';
import { findReplacement } from './find-replacement';
import type { FleetEntry } from './fleet-entry';

// One row per agent session id and target, the entry written last, plus every
// live row on another target, relinked one level deep. Every walk takes at most
// one step per entry, so it ends on any input.
export function buildFleetWithoutReplacedRows(entries: readonly FleetEntry[]): FleetEntry[] {
  const replaced = new Map<SessionID, SessionID>();

  for (const [index, entry] of entries.entries()) {
    const replacement = findReplacement(entry, entries, index + 1);

    if (replacement !== undefined) {
      replaced.set(entry.sessionID, replacement.sessionID);
    }
  }

  const kept = entries.filter((entry) => !replaced.has(entry.sessionID));

  const order = new Map(kept.map((entry, index) => [entry.sessionID, index]));
  const links = new Map(entries.map((entry) => [entry.sessionID, entry.parent]));

  const bound = entries.length;

  // The surviving row an entry's parent link resolves to, or undefined when
  // it resolves to no row the fleet keeps. A row that replaced its own parent
  // follows that parent's link instead.
  const findSurvivingParent = (entry: FleetEntry): SessionID | undefined => {
    let link = entry.parent;

    for (let step = 0; step < bound && link !== undefined; step++) {
      const target = replaced.get(link) ?? link;

      if (target !== entry.sessionID) {
        return order.has(target) ? target : undefined;
      }

      link = links.get(link);
    }

    return undefined;
  };

  const linked = new Map(kept.map((entry) => [entry.sessionID, findSurvivingParent(entry)]));

  // The row written first in the cycle a walk up from this row enters, or
  // undefined when the walk reaches a top-level row.
  const findCycleStart = (sessionID: SessionID): SessionID | undefined => {
    const seen: SessionID[] = [];
    let current: SessionID | undefined = sessionID;

    for (let step = 0; step <= bound && current !== undefined; step++) {
      const at = seen.indexOf(current);

      if (at !== -1) {
        return seen
          .slice(at)
          .toSorted((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))[0];
      }

      seen.push(current);

      current = linked.get(current);
    }

    return undefined;
  };

  for (const entry of kept) {
    const cycleStart = findCycleStart(entry.sessionID);

    if (cycleStart !== undefined) {
      linked.set(cycleStart, undefined);
    }
  }

  // The top-level row a walk up from this row reaches.
  const findTopLevel = (sessionID: SessionID): SessionID => {
    let current = sessionID;

    for (let step = 0; step < bound; step++) {
      const parent = linked.get(current);

      if (parent === undefined) {
        return current;
      }

      current = parent;
    }

    return current;
  };

  const relinked: FleetEntry[] = [];

  for (const entry of kept) {
    const { parent: _parent, ...rest } = entry;
    const top = findTopLevel(entry.sessionID);
    const row = top === entry.sessionID ? rest : { ...rest, parent: top };

    relinked.push(row);
  }

  return relinked;
}
