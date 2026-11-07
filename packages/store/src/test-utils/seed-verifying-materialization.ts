import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export async function seedVerifyingMaterialization(
  deps: MaterializationSeedDeps,
  input: Partial<NewMaterialization> = {},
): Promise<WorkspaceMaterialization> {
  const materialization = await seedMaterialization(deps, input);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    { phase: 'verifying' },
    deps.clock.now(),
  );

  const verifying = await deps.store.readMaterialization(materialization.sessionID);

  invariant(verifying?.phase === 'verifying');

  return verifying;
}
