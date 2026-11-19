import type { StepTimer } from '@atc/core';
import type { SessionID, SessionWorkspace } from '@atcx/contract';

export interface MaterializedSpawn {
  readonly workspace: SessionWorkspace;

  readonly branch: string | null;
  readonly withheldEnv: readonly string[];
}

export type SpawnMaterializer = (
  host: SpawnHostAccess,
  targetIdentity: string,
) => Promise<MaterializedSpawn | null>;

export interface SpawnHostAccess {
  readonly readyHost: (
    attempt: number,
  ) => Promise<{ readonly host: SessionID; readonly directory: string }>;
  readonly removeClaim: (directory: string) => Promise<boolean>;
  readonly timer: StepTimer;
}
