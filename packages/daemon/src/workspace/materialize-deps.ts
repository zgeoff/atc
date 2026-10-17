import type { InvalidGitTransports } from '@atc/config';
import type { Clock, StepTimer } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { StateStore } from '@atc/store';
import type { GitIdentity } from './read-host-git-identity';

// The host a workspace lands on, and the directory there it is built in.
export interface Landing {
  readonly host: string;
  readonly dir: string;
}

export interface MaterializeDeps {
  // The target's provider for one operation, after the execution gate
  // passes it; throws the gate's refusal otherwise.
  readonly requireProvider: (capability: 'run' | 'transfer') => ExecutionProvider;
  readonly store: Pick<StateStore, 'createMaterialization' | 'updateMaterialization'>;
  readonly log: (line: string) => void;

  // Readies the host on the target the workspace lands on and resolves to
  // it, once the source has resolved, with the directory of an attempt: the
  // first is the request's directory, and attempt n appends `-n` to it.
  readonly readyHost: (attempt: number) => Promise<Landing>;

  // Removes the directory this call claimed after a failure, and resolves
  // to whether it did; one it leaves holds what another session needs, or
  // no longer resolves to itself.
  readonly removeClaim: (dir: string) => Promise<boolean>;

  // The directory on the daemon's host that holds each clone's staging
  // directory while the workspace is built.
  readonly stagingRoot: string;

  // The transports a source may use and git may fetch over, or the invalid
  // list the config holds, which refuses every source that needs git.
  readonly gitTransports: readonly string[] | InvalidGitTransports;

  // Times each step of the build under its name, for the spawn it is for.
  readonly timer?: StepTimer;

  // Whether a git source is cloned inside the host the workspace lands on,
  // rather than cloned on the daemon's host and transferred there.
  readonly cloneOnTarget?: boolean;

  // The git identity written into the checkout's own config, for a host that
  // holds none of its own; unset or null writes nothing.
  readonly gitIdentity?: GitIdentity | null;

  // The clock each phase of the row is stamped with; the system clock when
  // unset.
  readonly clock?: Clock;
}
