import type { Config } from '@atc/config';
import type { AgentID } from '@atc/core';

export interface AgentPick {
  readonly agent: AgentID;
  readonly label: string;
}

export function collectAgentPicks(config: Config): AgentPick[] {
  // Spawns inherit this process's PATH, so the search list is read live
  // rather than left to the snapshot Bun.which defaults to.
  const opts = { PATH: process.env['PATH'] ?? '' };

  return config.agents
    .filter((entry) => Bun.which(entry.bin, opts) !== null)
    .map((entry) => ({ agent: entry.id, label: entry.label }));
}
