import type { MaterializationPhase } from '@atc/store';
import type { Landing } from './materialize-deps';

export interface MaterializationProgress {
  phase: MaterializationPhase;

  landing: Landing | null;

  claimed: boolean;
}

export type ProgressTracker = (update: Readonly<Partial<MaterializationProgress>>) => void;
