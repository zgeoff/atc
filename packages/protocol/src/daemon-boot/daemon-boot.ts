import type { AgentID } from '@atc/core';
import type { DaemonClient } from '../client/daemon-client';

export interface DaemonBoot {
  readonly client: DaemonClient;

  readonly stale: boolean;
  readonly lastUsedAgent: AgentID;

  readonly socketPath: string;
}
