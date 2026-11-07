import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export async function seedTransferringMaterialization(
  deps: MaterializationSeedDeps,
  input: Partial<NewMaterialization> = {},
): Promise<WorkspaceMaterialization> {
  const materialization = await seedMaterialization(deps, input);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    { phase: 'transferring' },
    deps.clock.now(),
  );

  const transferring = await deps.store.readMaterialization(materialization.sessionID);

  invariant(transferring?.phase === 'transferring');

  return transferring;
}
