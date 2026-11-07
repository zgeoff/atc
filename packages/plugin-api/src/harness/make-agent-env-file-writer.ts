import { rmSync } from 'node:fs';
import type { AgentID } from '@atc/core';
import { buildAgentEnvFilePath } from './build-agent-env-file-path';
import { writeAgentEnvFile } from './write-agent-env-file';

interface AgentEnvEntry {
  readonly id: AgentID;
  readonly env: Readonly<Record<string, string>>;
}

// Writes the entry's env file on its first call alone, so creating the
// writer touches no state; for an entry without env it removes the file an
// earlier run wrote, so a value taken out of the config leaves no copy.
export function makeAgentEnvFileWriter(
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
