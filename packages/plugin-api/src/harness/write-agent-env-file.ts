import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { AgentID } from '@atc/core';
import { buildAgentEnvFilePath } from './build-agent-env-file-path';
import { formatAgentEnvFile } from './format-agent-env-file';

const OWNER_ONLY_MODE = 0o600;

// writeFileSync applies the mode only to a file it creates, so the values go
// into a new file that then replaces any file an earlier run left.
export function writeAgentEnvFile(
  directory: string,
  agentID: AgentID,
  env: Readonly<Record<string, string>>,
): string {
  const file = buildAgentEnvFilePath(directory, agentID);
  const staged = `${file}.${randomUUID()}`;

  mkdirSync(directory, { recursive: true });
  writeFileSync(staged, formatAgentEnvFile(env), { mode: OWNER_ONLY_MODE, flag: 'wx' });
  renameSync(staged, file);

  return file;
}
