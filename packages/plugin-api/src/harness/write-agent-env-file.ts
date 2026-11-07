import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentID } from '@atc/core';
import { formatAgentEnvFile } from './format-agent-env-file';

const OWNER_ONLY_MODE = 0o600;

// The entry's env file in the state folder, readable by its owner alone.
// writeFileSync applies the mode only to a file it creates, so a file an
// earlier daemon left is narrowed too.
export function writeAgentEnvFile(
  directory: string,
  agentID: AgentID,
  env: Readonly<Record<string, string>>,
): string {
  const file = join(directory, `agent-env-${agentID}.sh`);

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, formatAgentEnvFile(env), { mode: OWNER_ONLY_MODE });
  chmodSync(file, OWNER_ONLY_MODE);

  return file;
}
