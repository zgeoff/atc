import type { InvalidGitTransports } from '@atc/config';
import type { StepTimer } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { StateStore } from '@atc/store';
import type { Clock } from '@zgeoff/std';
import type { GitIdentity } from './read-host-git-identity';

export interface Landing {
  readonly host: string;
  readonly directory: string;
}

export interface MaterializeDeps {
  readonly requireProvider: (capability: 'run' | 'transfer') => ExecutionProvider;
  readonly store: Pick<StateStore, 'createMaterialization' | 'updateMaterialization'>;
  readonly log: (line: string) => void;

  readonly readyHost: (attempt: number) => Promise<Landing>;

  readonly removeClaim: (directory: string) => Promise<boolean>;

  readonly stagingRoot: string;

  readonly gitTransports: readonly string[] | InvalidGitTransports;

  readonly timer?: StepTimer;

  readonly cloneOnTarget?: boolean;

  readonly gitIdentity?: GitIdentity | null;

  readonly clock?: Pick<Clock, 'now' | 'schedule'>;
}
