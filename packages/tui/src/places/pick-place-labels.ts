import type { DaemonName } from '../fleet/session-key';
import { toDaemonLabel } from './to-session-place';
import type { SessionPlace } from './types';

interface PlacedSession {
  readonly daemon: DaemonName;
  readonly place: SessionPlace;
}

interface Candidate {
  readonly daemon: DaemonName;
  readonly rank: number;
  readonly label: string;
}

// One label for each place key. Daemons that give one place different labels lose to the daemon on
// this computer, then to the daemon listed first in the config. Two places that end up with one
// label each take `<label> · <daemon name>`, with the name of the daemon whose label shows.
export function pickPlaceLabels(
  sessions: readonly PlacedSession[],
  daemonOrder: readonly DaemonName[],
): ReadonlyMap<string, string> {
  const chosen = new Map<string, Candidate>();

  for (const session of sessions) {
    const candidate: Candidate = {
      daemon: session.daemon,
      rank: rankDaemon(session.daemon, daemonOrder),
      label: session.place.label,
    };

    const held = chosen.get(session.place.key);

    if (held === undefined || candidate.rank < held.rank) {
      chosen.set(session.place.key, candidate);
    }
  }

  const keysByLabel = new Map<string, number>();

  for (const candidate of chosen.values()) {
    keysByLabel.set(candidate.label, (keysByLabel.get(candidate.label) ?? 0) + 1);
  }

  const labels = new Map<string, string>();

  for (const [key, candidate] of chosen) {
    const isShared = (keysByLabel.get(candidate.label) ?? 0) > 1;

    const label = isShared
      ? `${candidate.label} · ${toDaemonLabel(candidate.daemon)}`
      : candidate.label;

    labels.set(key, label);
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
