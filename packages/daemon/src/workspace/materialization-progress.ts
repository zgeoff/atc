import type { MaterializationPhase } from '@atc/store';
import type { Landing } from './materialize-deps';

export interface MaterializationProgress {
  phase: MaterializationPhase;

  // The host the workspace lands on and its directory there, once the
  // host is ready.
  landing: Landing | null;

  // Whether this call created the target directory, so a failure removes
  // only a directory it made.
  claimed: boolean;
}

// Moves a materialization's progress along as each step completes.
export type ProgressTracker = (update: Readonly<Partial<MaterializationProgress>>) => void;
