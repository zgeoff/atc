import type { AgentID } from '@atc/core';
import type { DaemonClient } from './client/daemon-client';

export interface DaemonBoot {
  readonly client: DaemonClient;

  // whether the daemon runs another build than the client
  readonly stale: boolean;
  readonly lastUsedAgent: AgentID;

  // The socket the client reached, which differs from the computed one when
  // the daemon was found through its record in the state directory.
  readonly socketPath: string;
}
