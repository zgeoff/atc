import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentID } from '@atc/core';

// An agent id may hold any character at any length, so the file name holds a
// fixed-length digest of it, which stays inside the folder and under the
// 255-byte name limit with the staged copy's suffix.
export function buildAgentEnvFilePath(directory: string, agentID: AgentID): string {
  const digest = createHash('sha256').update(agentID).digest('hex').slice(0, 32);

  return join(directory, `agent-env-${digest}.sh`);
}
