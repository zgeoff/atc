import type { AgentID } from '../agents/agent-adapter';
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

  const candidates: readonly (AgentPick & { readonly bin: string })[] = [
    { agent: 'claude', label: 'Claude', bin: config.claudeBin },
    { agent: 'grok', label: 'Grok', bin: config.grokBin },
    { agent: 'codex', label: 'Codex', bin: config.codexBin },
    ...config.gateways.map((g) => ({ agent: g.id, label: g.label, bin: g.bin })),
  ];

  return candidates
    .filter((c) => Bun.which(c.bin, opts) !== null)
    .map((c) => ({ agent: c.agent, label: c.label }));
}
