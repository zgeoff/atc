import { systemClock } from '@atc/core';
import type { MaterializationPhase } from '@atc/store';
import type { ProgressTracker } from './materialization-progress';
import type { MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';

export async function recordPhase(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  phase: MaterializationPhase,
  fields: Readonly<{
    directory?: string;
    repoURL?: string;
    sha?: string;
    ref?: string | null;
    materializedAt?: number;
  }>,
): Promise<void> {
  await deps.store.updateMaterialization(
    request.sessionID,
    { phase, ...fields },
    (deps.clock ?? systemClock).now(),
  );

  updateProgress({ phase });
}
