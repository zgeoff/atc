import { sortGroupedSessionViews, sortSessionViews } from '@atc/protocol';
import { findFuzzyScore, formatDir } from '../terminal/pick-matches';
import { collectPinnedFirst } from './collect-pinned-first';
import type { DaemonName } from './session-key';
import type { MirrorSession } from './to-mirror-session';

interface RowOptions {
  readonly daemons: readonly DaemonName[];
  readonly grouped: boolean;
  readonly filter: string | null;
}

// Each daemon's rows sort and filter on their own, so a sub-session never nests under another daemon's row that has the same id.
export function collectSessionRows(
  sessions: readonly MirrorSession[],
  options: RowOptions,
): MirrorSession[] {
  const fleets = options.daemons.map((daemon) =>
    collectFleetRows(
      sessions.filter((session) => session.daemon === daemon),
      options,
    ),
  );

  return collectPinnedFirst(fleets);
}

function collectFleetRows(fleet: readonly MirrorSession[], options: RowOptions): MirrorSession[] {
  const sorted = options.grouped ? sortGroupedSessionViews(fleet) : sortSessionViews(fleet);

  if (options.filter === null || options.filter === '') {
    return sorted;
  }

  const query = options.filter;

  const matched = new Set(
    sorted
      .filter(
        (session) => findFuzzyScore(`${session.name} ${formatDir(session.cwd)}`, query) !== null,
      )
      .map((session) => session.id),
  );

  return sorted.filter(
    (session) =>
      matched.has(session.id) ||
      sorted.some((child) => child.parent === session.id && matched.has(child.id)),
  );
}
