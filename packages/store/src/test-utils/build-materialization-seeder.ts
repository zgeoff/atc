import type { NewMaterialization } from '../workspace-materialization';
import { seedCloningMaterialization } from './seed-cloning-materialization';
import { seedFailedMaterialization } from './seed-failed-materialization';
import { seedMaterialization } from './seed-materialization';
import type { MaterializationSeedDeps } from './seed-materialization';
import { seedReadyMaterialization } from './seed-ready-materialization';
import type { ReadyMaterializationInput } from './seed-ready-materialization';
import { seedTransferringMaterialization } from './seed-transferring-materialization';
import { seedVerifyingMaterialization } from './seed-verifying-materialization';

export function buildMaterializationSeeder(deps: MaterializationSeedDeps) {
  return {
    materialization: (input?: Partial<NewMaterialization>) => seedMaterialization(deps, input),
    cloningMaterialization: (input?: Partial<NewMaterialization>) =>
      seedCloningMaterialization(deps, input),
    transferringMaterialization: (input?: Partial<NewMaterialization>) =>
      seedTransferringMaterialization(deps, input),
    verifyingMaterialization: (input?: Partial<NewMaterialization>) =>
      seedVerifyingMaterialization(deps, input),
    readyMaterialization: (input?: ReadyMaterializationInput) =>
      seedReadyMaterialization(deps, input),
    failedMaterialization: (input?: Partial<NewMaterialization>) =>
      seedFailedMaterialization(deps, input),
  };
}
