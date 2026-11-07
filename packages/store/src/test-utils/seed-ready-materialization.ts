import { faker } from '@faker-js/faker';
import invariant from 'tiny-invariant';
import type { NewMaterialization, WorkspaceMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';

export type ReadyMaterializationInput = Partial<
  NewMaterialization & { readonly repoURL: string; readonly sha: string }
>;

export async function seedReadyMaterialization(
  deps: MaterializationSeedDeps,
  input: ReadyMaterializationInput = {},
): Promise<WorkspaceMaterialization> {
  const { repoURL, sha, ...created } = input;

  const materialization = await seedMaterialization(deps, created);

  await deps.store.updateMaterialization(
    materialization.sessionID,
    {
      phase: 'ready',
      repoURL: repoURL ?? faker.internet.url(),
      sha: sha ?? faker.git.commitSha(),
      materializedAt: deps.clock.now(),
    },
    deps.clock.now(),
  );

  const ready = await deps.store.readMaterialization(materialization.sessionID);

  invariant(ready?.phase === 'ready');

  return ready;
}
