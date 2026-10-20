import type { SessionID } from '@atc/core';

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

  // The directory on the target the workspace is materialized into.
  readonly directory: string;
  readonly sourceKind: 'path' | 'git';
  readonly phase: MaterializationPhase;

  // The token-free form: the row never holds a credential or a reference to one.
  readonly repoURL: string | null;
  readonly sha: string | null;

  // The branch or tag the commit was resolved from; null for a pinned
  // commit or a detached checkout.
  readonly ref: string | null;

  // The refusal that failed the materialization; null unless failed.
  readonly errorCode: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly materializedAt: number | null;

  // The environment variable names every harness the session starts goes
  // without: the workspace credential's variable and the askpass context.
  readonly withheldEnv: readonly string[];
}

// The fields a materialization rewrites as it moves through its phases.
export interface MaterializationUpdate {
  readonly phase: MaterializationPhase;

  // The directory the workspace landed in, once a directory the daemon
  // picked is claimed.
  readonly directory?: string;
  readonly repoURL?: string;
  readonly sha?: string;
  readonly ref?: string | null;
  readonly errorCode?: string;
  readonly materializedAt?: number;
}
