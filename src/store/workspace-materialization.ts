import type { SessionID } from '../shared/session-id';

/**
 * Where a spawn's workspace stands on its way to the execution target:
 * resolving the source to a commit, cloning it on the daemon's host,
 * transferring the archive to the target, and verifying the target's
 * checkout, then `ready` or `failed`. A row a stopped daemon left in any
 * other phase is reconciled to `failed` before the next daemon serves a
 * request, so no workspace ever counts as ready without its verification.
 */
export type MaterializationPhase =
  | 'resolving'
  | 'cloning'
  | 'transferring'
  | 'verifying'
  | 'ready'
  | 'failed';

/**
 * One spawn's workspace materialization, keyed by the session it is for.
 * The repository URL is the token-free form, and the row never holds a
 * credential or the reference to one.
 */
export interface WorkspaceMaterialization {
  readonly sessionID: SessionID;
  readonly target: string;

  // The directory on the target the workspace is materialized into.
  readonly dir: string;
  readonly sourceKind: 'path' | 'git';
  readonly phase: MaterializationPhase;
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
  readonly repoURL?: string;
  readonly sha?: string;
  readonly ref?: string | null;
  readonly errorCode?: string;
  readonly materializedAt?: number;
}

/**
 * What a session's ready workspace was built from: the token-free
 * repository URL, the commit checked out, the branch or tag it came from,
 * and when it became ready.
 */
export interface SessionWorkspace {
  readonly repoURL: string;
  readonly sha: string;
  readonly ref?: string;
  readonly materializedAt: number;
}
