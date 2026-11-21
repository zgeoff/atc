import type { StateStore } from '@atc/store';
import { buildMaterializationSeeder } from '@atc/store/test-utils/build-materialization-seeder';
import { buildSessionOwnerSeeder } from '@atc/store/test-utils/build-session-owner-seeder';
import type { Clock } from '@zgeoff/std';

export interface TestDeps {
  readonly store: StateStore;
  readonly clock: Pick<Clock, 'now'>;
  readonly dbPath: string;
}

export function buildSeeder(deps: TestDeps) {
  return { ...buildMaterializationSeeder(deps), ...buildSessionOwnerSeeder(deps) };
}
