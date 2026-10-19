import type { AgentID } from '@atc/core';
import type { DaemonClient } from './client/daemon-client';
import type { DaemonFeature } from './daemon-features';

export interface DaemonBoot {
  readonly client: DaemonClient;

  // whether the daemon runs another build than the client
  readonly stale: boolean;
  readonly lastUsedAgent: AgentID;

  // What the daemon announced it serves; an older daemon announces less.
  readonly features: ReadonlySet<DaemonFeature>;

  // The socket the client reached, which differs from the computed one when
  // the daemon was found through its record in the state directory.
  readonly socketPath: string;
}
