import type { NewMaterialization } from '../workspace-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';
import { seedReadyMaterialization } from './seed-ready-materialization';
import type { ReadyMaterializationInput } from './seed-ready-materialization';

export function buildMaterializationSeeder(deps: MaterializationSeedDeps) {
  return {
    materialization: (input?: Partial<NewMaterialization>) => seedMaterialization(deps, input),
    readyMaterialization: (input?: ReadyMaterializationInput) =>
      seedReadyMaterialization(deps, input),
  };
}
