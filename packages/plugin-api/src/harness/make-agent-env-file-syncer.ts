import { rmSync } from 'node:fs';
import type { AgentID } from '@atc/core';
import { buildAgentEnvFilePath } from './build-agent-env-file-path';
import { writeAgentEnvFile } from './write-agent-env-file';

interface AgentEnvEntry {
  readonly id: AgentID;
  readonly env: Readonly<Record<string, string>>;
}

// Syncs on the first call alone, so creating the syncer touches no state. An
// entry without env removes the file an earlier run wrote, so a value taken
// out of the config leaves no copy.
export function makeAgentEnvFileSyncer(
  entry: AgentEnvEntry,
  directory: string,
): () => string | null {
  let file: string | null | undefined;

  return () => {
    if (file !== undefined) {
      return file;
    }

    if (Object.keys(entry.env).length === 0) {
      rmSync(buildAgentEnvFilePath(directory, entry.id), { force: true });

      file = null;

      return file;
    }

    file = writeAgentEnvFile(directory, entry.id, entry.env);

    return file;
  };
}
