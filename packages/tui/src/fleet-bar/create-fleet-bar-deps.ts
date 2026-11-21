import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import { isLinkDown } from '../daemon-link/daemon-link-state';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { buildFleetBar } from './build-fleet-bar';
import type { FleetBarLayerDeps } from './create-fleet-bar-layer';

export interface FleetBarDepsSource {
  readonly mirror: Pick<FleetMirror, 'sessions'>;

  // read late, because the links open after the screen
  readonly links: () => Pick<DaemonLinks, 'listDaemons' | 'stateOf'>;
  readonly leaderLabel: string;
  readonly findFocused: () => MirrorSession | null;
  readonly isShown: () => boolean;
}

// What the fleet bar layer reads: the fleet mirror, which daemon links are down, and the place
// of the attached session.
export function createFleetBarDeps(source: FleetBarDepsSource): FleetBarLayerDeps {
  return {
    isShown: source.isShown,
    isSpinning: () => source.mirror.sessions.some((session) => session.state === 'running'),
    readBar: (cols, spinnerFrame) => {
      const links = source.links();
      const daemons = links.listDaemons();

      return buildFleetBar(source.mirror.sessions, {
        cols,
        leaderLabel: source.leaderLabel,
        attachedPlaceKey: source.findFocused()?.place.key ?? null,
        daemonOrder: daemons,
        downDaemons: new Set(daemons.filter((daemon) => isLinkDown(links.stateOf(daemon)))),
        spinnerFrame,
      });
    },
  };
}
