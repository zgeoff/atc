import type { Clock } from '@atc/core';
import invariant from 'tiny-invariant';
import type { StateStore } from '../create-state-store';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { buildMockNewMaterialization } from './build-mock-new-materialization';

export interface MaterializationSeedDeps {
  readonly store: StateStore;
  readonly clock: Pick<Clock, 'now'>;
}

export async function seedMaterialization(
  deps: MaterializationSeedDeps,
  input: Partial<NewMaterialization> = {},
): Promise<WorkspaceMaterialization> {
  const row = buildMockNewMaterialization(input);

  await deps.store.createMaterialization(row, deps.clock.now());

  const materialization = await deps.store.readMaterialization(row.sessionID);

  invariant(materialization?.phase === 'resolving');

  return materialization;
}
