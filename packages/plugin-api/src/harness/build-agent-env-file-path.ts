import { join } from 'node:path';
import type { AgentID } from '@atc/core';

// An agent id may hold any character, so the file name encodes it, and an id
// such as `team/codex` or `../x` names a file inside the folder.
export function buildAgentEnvFilePath(directory: string, agentID: AgentID): string {
  return join(directory, `agent-env-${encodeURIComponent(agentID)}.sh`);
}
