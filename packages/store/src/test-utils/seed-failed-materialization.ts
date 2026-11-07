import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export async function seedFailedMaterialization(
  deps: MaterializationSeedDeps,
  input: Partial<NewMaterialization> = {},
): Promise<WorkspaceMaterialization> {
  const materialization = await seedMaterialization(deps, input);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    { phase: 'failed', errorCode: 'sanitize_failed' },
    deps.clock.now(),
  );

  const failed = await deps.store.readMaterialization(materialization.sessionID);

  invariant(failed?.phase === 'failed');

  return failed;
}
