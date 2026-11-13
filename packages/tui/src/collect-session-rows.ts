import { sortGroupedSessionViews, sortSessionViews } from '@atc/protocol';
import { findFuzzyScore, formatDir } from './dirs';
import type { DaemonName } from './session-key';
import type { MirrorSession } from './to-mirror-session';

interface RowOptions {
  // The daemons in the order their rows list: the primary first.
  readonly daemons: readonly DaemonName[];
  readonly grouped: boolean;
  readonly filter: string | null;
}

// The rows of the session list: each daemon's rows sort and filter on their own, so a
// sub-session never nests under another daemon's row that has the same id.
export function collectSessionRows(
  sessions: readonly MirrorSession[],
  options: RowOptions,
): MirrorSession[] {
  return options.daemons.flatMap((daemon) => {
    const fleet = sessions.filter((session) => session.daemon === daemon);
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

    // A matching sub-session keeps its parent row, so it stays nested.
    return sorted.filter(
      (session) =>
        matched.has(session.id) ||
        sorted.some((child) => child.parent === session.id && matched.has(child.id)),
    );
  });
}
