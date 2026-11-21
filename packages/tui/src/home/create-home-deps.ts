import type { FleetMirror } from '../fleet/create-fleet-mirror';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { buildHomeInput } from './build-home-input';
import type { HomeNoticeSource } from './collect-home-notices';
import type { HomeLayerDeps } from './create-home-layer';

export interface HomeDepsSource {
  readonly mirror: Pick<FleetMirror, 'count'>;
  readonly listVisible: () => readonly MirrorSession[];
  readonly leaderLabel: string;
  readonly readNoticeSource: () => HomeNoticeSource;
}

// What the home layer reads: the sessions the list shows, the leader key and the notices.
export function createHomeDeps(source: HomeDepsSource): HomeLayerDeps {
  return {
    readInput: () =>
      buildHomeInput({
        ...source.readNoticeSource(),
        sessionStates: source.listVisible().map((session) => session.state),
        leaderLabel: source.leaderLabel,
        restorableCount: source.mirror.count,
      }),
  };
}
