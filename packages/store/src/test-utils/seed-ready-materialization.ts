import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export async function seedReadyMaterialization(
  deps: MaterializationSeedDeps,
  input: Partial<NewMaterialization> = {},
): Promise<WorkspaceMaterialization> {
  const materialization = await seedMaterialization(deps, input);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    {
      phase: 'ready',
      repoURL: 'https://example.com/acme/app.git',
      sha: '0123456789abcdef0123456789abcdef01234567',
      materializedAt: deps.clock.now(),
    },
    deps.clock.now(),
  );

  const ready = await deps.store.readMaterialization(materialization.sessionID);

  invariant(ready?.phase === 'ready');

  return ready;
}
