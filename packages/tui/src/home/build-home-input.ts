import { collectHomeNotices } from './collect-home-notices';
import type { HomeNoticeSource } from './collect-home-notices';
import type { HomeInput } from './types';

interface HomeInputSource extends HomeNoticeSource {
  readonly sessionStates: readonly string[];
  readonly leaderLabel: string;
  readonly restorableCount: number;
}

// What home shows: how many sessions the fleet holds, how many need the user, the leader key's
// label and the notices.
export function buildHomeInput(source: HomeInputSource): HomeInput {
  return {
    sessionCount: source.sessionStates.length,
    needYouCount: source.sessionStates.filter((state) => state === 'needs_you').length,
    leaderLabel: source.leaderLabel,
    restorableCount: source.restorableCount,
    notices: collectHomeNotices(source),
  };
}
