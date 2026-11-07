import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';
import { buildMaterializationSeeder, buildSessionOwnerSeeder } from '@atc/store/test-utils';

export interface TestDeps {
  readonly store: StateStore;
  readonly clock: Pick<Clock, 'now'>;
  readonly dbPath: string;
}

export function buildSeeder(deps: TestDeps) {
  return { ...buildMaterializationSeeder(deps), ...buildSessionOwnerSeeder(deps) };
}
