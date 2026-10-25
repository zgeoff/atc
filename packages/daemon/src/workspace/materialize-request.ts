import type { SessionID, SpawnWorkspaceSource } from '@atcx/contract';

export interface MaterializeRequest {
  readonly sessionID: SessionID;
  readonly target: string;

  // The directory on the target the workspace lands in; it must not exist.
  readonly directory: string;
  readonly source: SpawnWorkspaceSource;

  // Whether the target is the daemon's own host, where a directory outside
  // any git work tree runs in place instead of being materialized.
  readonly inPlace: boolean;

  // Whether the daemon picked the directory, so one that exists or that
  // another workspace holds moves the claim to the next attempt's
  // directory instead of refusing the spawn.
  readonly autoDir?: boolean;
}
