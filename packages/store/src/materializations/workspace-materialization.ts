import type { SessionID } from '@atcx/contract';

export type MaterializationPhase =
  | 'resolving'
  | 'cloning'
  | 'transferring'
  | 'verifying'
  | 'ready'
  | 'failed';

export interface WorkspaceMaterialization {
  readonly sessionID: SessionID;
  readonly target: string;

  readonly directory: string;
  readonly sourceKind: 'path' | 'git';
  readonly phase: MaterializationPhase;

  readonly repoURL: string | null;
  readonly sha: string | null;

  readonly ref: string | null;

  readonly errorCode: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly materializedAt: number | null;

  readonly withheldEnv: readonly string[];
}

export type NewMaterialization = Pick<
  WorkspaceMaterialization,
  'sessionID' | 'target' | 'directory' | 'sourceKind' | 'withheldEnv'
>;

export interface MaterializationUpdate {
  readonly phase: MaterializationPhase;

  readonly directory?: string;
  readonly repoURL?: string;
  readonly sha?: string;
  readonly ref?: string | null;
  readonly errorCode?: string;
  readonly materializedAt?: number;
}
