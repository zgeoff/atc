import type { StepTimer } from '@atc/core';
import type { SessionID, SessionWorkspace } from '@atcx/contract';

// A session's ready workspace and the variables its harnesses go without.
export interface MaterializedSpawn {
  readonly workspace: SessionWorkspace;

  // The branch the checkout is on, null for a detached checkout.
  readonly branch: string | null;
  readonly withheldEnv: readonly string[];
}

// resolves to null for a directory that runs as it stands
export type SpawnMaterializer = (
  host: SpawnHostAccess,
  targetIdentity: string,
) => Promise<MaterializedSpawn | null>;

export interface SpawnHostAccess {
  // called once the source resolves; attempt 1 is the spawn's directory, and
  // attempt n is that directory with `-n` appended
  readonly readyHost: (
    attempt: number,
  ) => Promise<{ readonly host: SessionID; readonly directory: string }>;
  readonly removeClaim: (directory: string) => Promise<boolean>;
  readonly timer: StepTimer;
}
