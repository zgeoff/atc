import type { SessionID, SpawnWorkspaceSource } from '@atcx/contract';

export interface MaterializeRequest {
  readonly sessionID: SessionID;
  readonly target: string;

  readonly directory: string;
  readonly source: SpawnWorkspaceSource;

  readonly inPlace: boolean;

  readonly autoDir?: boolean;
}
