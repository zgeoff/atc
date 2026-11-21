import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { buildHomeInput } from './build-home-input';
import type { HomeNoticeSource } from './collect-home-notices';
import type { HomeLayerDeps } from './create-home-layer';

export interface HomeDepsSource {
  readonly mirror: Pick<FleetMirror, 'sessions' | 'count'>;
  readonly leaderLabel: string;
  readonly readNoticeSource: () => HomeNoticeSource;
}

// What the home layer reads: the fleet mirror, the leader key and the notices.
export function createHomeDeps(source: HomeDepsSource): HomeLayerDeps {
  return {
    readInput: () =>
      buildHomeInput({
        ...source.readNoticeSource(),
        sessionStates: source.mirror.sessions.map((session) => session.state),
        leaderLabel: source.leaderLabel,
        restorableCount: source.mirror.count,
      }),
  };
}
