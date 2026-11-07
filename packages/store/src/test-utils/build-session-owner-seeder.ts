import type { SessionOwnerRow } from './build-mock-session-owner-row';
import { seedLaterEpochSessionOwner } from './seed-later-epoch-session-owner';
import type { SessionOwnerSeedDeps } from './seed-later-epoch-session-owner';

export function buildSessionOwnerSeeder(deps: SessionOwnerSeedDeps) {
  return {
    laterEpochSessionOwner: (input?: Partial<SessionOwnerRow>) =>
      seedLaterEpochSessionOwner(deps, input),
  };
}
