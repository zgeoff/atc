import type { DaemonName } from '../fleet/session-key';
import { toDaemonLabel } from './to-session-place';
import type { SessionPlace } from './types';

interface PlacedSession {
  readonly daemon: DaemonName;
  readonly target: string;
  readonly place: SessionPlace;
}

interface Candidate {
  readonly rank: number;
  readonly label: string;

  // what tells two places with one label apart, in the order the label takes them
  readonly qualifiers: readonly string[];
}

// One label for each place key. The daemon on this computer wins a disagreement, then the daemon
// listed first in the config. Two places with one label add the daemon name, then the target id,
// then the place key, until they differ.
export function pickPlaceLabels(
  sessions: readonly PlacedSession[],
  daemonOrder: readonly DaemonName[],
): ReadonlyMap<string, string> {
  const chosen = new Map<string, Candidate>();

  for (const session of sessions) {
    const label = session.place.label;

    const candidate: Candidate = {
      rank: rankDaemon(session.daemon, daemonOrder),
      label,
      qualifiers: [toDaemonLabel(session.daemon), session.target, session.place.key].filter(
        (qualifier) => qualifier !== label,
      ),
    };

    const held = chosen.get(session.place.key);

    if (held === undefined || candidate.rank < held.rank) {
      chosen.set(session.place.key, candidate);
    }
  }

  const labels = new Map<string, string>();

  for (const [key, candidate] of chosen) {
    labels.set(key, pickDistinctLabel(candidate, [...chosen.values()]));
  }

  return labels;
}

function rankDaemon(daemon: DaemonName, daemonOrder: readonly DaemonName[]): number {
  if (daemon === null) {
    return -1;
  }

  const index = daemonOrder.indexOf(daemon);

  return index === -1 ? daemonOrder.length : index;
}

// the shortest label, with qualifiers added one at a time, that no other place shares
function pickDistinctLabel(candidate: Candidate, all: readonly Candidate[]): string {
  const others = all.filter((other) => other !== candidate);

  for (let depth = 0; depth < candidate.qualifiers.length; depth++) {
    const label = formatLabel(candidate, depth);

    if (others.every((other) => formatLabel(other, depth) !== label)) {
      return label;
    }
  }

  return formatLabel(candidate, candidate.qualifiers.length);
}

function formatLabel(candidate: Candidate, depth: number): string {
  return [candidate.label, ...candidate.qualifiers.slice(0, depth)].join(' · ');
}
