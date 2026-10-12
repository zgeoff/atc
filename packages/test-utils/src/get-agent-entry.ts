import type { AgentEntry } from '@atc/config/agent-entry';
import type { Config } from '@atc/config/config';

/**
 * The registry entry a parsed config holds under an agent id. A test that
 * builds an adapter from a config reads the entry through this, so a config
 * that lacks the agent fails the test with the id named.
 */
export function getAgentEntry(config: Pick<Config, 'agents'>, id: string): AgentEntry {
  const entry = config.agents.find((candidate) => candidate.id === id);

  if (entry === undefined) {
    throw new Error(`the config holds no agent '${id}'`);
  }

  return entry;
}
