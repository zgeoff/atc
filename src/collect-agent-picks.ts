import type { AgentKind } from './agent-adapter';
import type { Config } from './config';

export interface AgentPick {
  readonly agent: AgentKind;
  readonly label: string;

  // The binary configured for this agent, as written in config.
  readonly bin: string;

  // Where that binary resolves, or null when nothing executable answers to
  // it — a pick the spawn flow refuses.
  readonly binPath: string | null;
}

/**
 * The agent choices offered at spawn and adopt, in menu order, each carrying
 * whether its configured binary is executable right now. Resolution follows
 * the rule a spawn follows: a bare name comes off PATH, a name carrying a
 * separator is taken as a path.
 */
export function collectAgentPicks(config: Config): AgentPick[] {
  // Spawns inherit this process's PATH, so the search list is read live
  // rather than left to the snapshot Bun.which defaults to.
  const opts = { PATH: process.env['PATH'] ?? '' };

  return [
    {
      agent: 'claude',
      label: 'Claude',
      bin: config.claudeBin,
      binPath: Bun.which(config.claudeBin, opts),
    },
    { agent: 'grok', label: 'Grok', bin: config.grokBin, binPath: Bun.which(config.grokBin, opts) },
    {
      agent: 'codex',
      label: 'Codex',
      bin: config.codexBin,
      binPath: Bun.which(config.codexBin, opts),
    },
  ];
}
