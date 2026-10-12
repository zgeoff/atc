import type { AgentID } from '../shared/agent-id';
import type { Config } from '../shared/config';

export interface AgentPick {
  readonly agent: AgentID;
  readonly label: string;
}

/**
 * The agent choices the spawn and adopt flows offer, in menu order. An agent
 * whose configured binary does not resolve is left out, so every row in the
 * menu is a session that can start. Resolution follows the rule a spawn
 * follows: a bare name comes off PATH, a name carrying a separator is taken
 * as a path, and either way it has to be executable.
 */
export function collectAgentPicks(config: Config): AgentPick[] {
  // Spawns inherit this process's PATH, so the search list is read live
  // rather than left to the snapshot Bun.which defaults to.
  const opts = { PATH: process.env['PATH'] ?? '' };

  return config.agents
    .filter((entry) => Bun.which(entry.bin, opts) !== null)
    .map((entry) => ({ agent: entry.id, label: entry.label }));
}
