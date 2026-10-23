import { systemClock } from '@atc/core';
import type { MaterializationPhase } from '@atc/store';
import type { ProgressTracker } from './materialization-progress';
import type { MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';

interface RecordPhaseOptions {
  readonly phase: MaterializationPhase;
  readonly directory?: string;
  readonly repoURL?: string;
  readonly sha?: string;
  readonly ref?: string | null;
  readonly materializedAt?: number;
}

export async function recordPhase(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  options: RecordPhaseOptions,
): Promise<void> {
  await deps.store.updateMaterialization(
    request.sessionID,
    { ...options },
    (deps.clock ?? systemClock).now(),
  );

  updateProgress({ phase: options.phase });
}
