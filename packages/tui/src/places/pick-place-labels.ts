import type { DaemonName } from '../fleet/session-key';
import { pickDistinctLabels } from './pick-distinct-labels';
import type { LabelCandidate } from './pick-distinct-labels';
import { toDaemonLabel } from './to-session-place';
import type { SessionPlace } from './types';

interface PlacedSession {
  readonly daemon: DaemonName;
  readonly target: string;
  readonly place: SessionPlace;
}

interface Candidate extends LabelCandidate {
  readonly rank: number;
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

  const keys = [...chosen.keys()];
  const labels = pickDistinctLabels([...chosen.values()]);

  return new Map(keys.map((key, index) => [key, labels[index] ?? key]));
}

function rankDaemon(daemon: DaemonName, daemonOrder: readonly DaemonName[]): number {
  if (daemon === null) {
    return -1;
  }

  const index = daemonOrder.indexOf(daemon);

  return index === -1 ? daemonOrder.length : index;
}
