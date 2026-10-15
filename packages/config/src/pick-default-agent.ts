import type { AgentID } from '@atc/core';
import type { AgentEntry } from './agent-entry';

/**
 * The agent a spawn without one runs: `claude` when the registry holds an
 * entry with that id, else the first entry. An empty registry still reports
 * `claude`, so a spawn is refused for want of an adapter rather than for an
 * unknown default.
 */
export function pickDefaultAgent(agents: readonly AgentEntry[]): AgentID {
  return agents.find((entry) => entry.id === 'claude')?.id ?? agents[0]?.id ?? 'claude';
}
