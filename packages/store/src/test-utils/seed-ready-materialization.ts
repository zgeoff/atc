import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export type ReadyMaterializationInput = Partial<NewMaterialization> & {
  repoURL?: string;
  sha?: string;
};

export async function seedReadyMaterialization(
  deps: MaterializationSeedDeps,
  input: ReadyMaterializationInput = {},
): Promise<WorkspaceMaterialization> {
  const {
    repoURL = 'https://example.com/acme/app.git',
    sha = '0123456789abcdef0123456789abcdef01234567',
    ...newMaterialization
  } = input;

  const materialization = await seedMaterialization(deps, newMaterialization);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    {
      phase: 'ready',
      repoURL,
      sha,
      materializedAt: deps.clock.now(),
    },
    deps.clock.now(),
  );

  const ready = await deps.store.readMaterialization(materialization.sessionID);

  invariant(ready?.phase === 'ready');

  return ready;
}
