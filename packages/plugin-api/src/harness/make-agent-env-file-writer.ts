import type { AgentID } from '@atc/core';
import { writeAgentEnvFile } from './write-agent-env-file';

interface AgentEnvEntry {
  readonly id: AgentID;
  readonly env: Readonly<Record<string, string>>;
}

// Writes the entry's env file on its first call and returns its path
// afterwards, so creating the writer touches no state; an entry without env
// writes none and gets null.
export function makeAgentEnvFileWriter(
  entry: AgentEnvEntry,
  directory: string,
): () => string | null {
  let file: string | undefined;

  return () => {
    if (Object.keys(entry.env).length === 0) {
      return null;
    }

    file ??= writeAgentEnvFile(directory, entry.id, entry.env);

    return file;
  };
}
