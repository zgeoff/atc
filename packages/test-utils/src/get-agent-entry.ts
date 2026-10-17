import type { AgentEntry, Config } from '@atc/config';

export function getAgentEntry(config: Pick<Config, 'agents'>, id: string): AgentEntry {
  const entry = config.agents.find((candidate) => candidate.id === id);

  if (entry === undefined) {
    throw new Error(`the config holds no agent '${id}'`);
  }

  return entry;
}
