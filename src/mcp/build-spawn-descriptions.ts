/**
 * One agent as the spawn descriptions list it: its id and whether its binary
 * resolves on the daemon's host.
 */
export interface RegisteredAgent {
  readonly id: string;
  readonly installed: boolean;
}

interface SpawnDescriptions {
  readonly tool: string;
  readonly agent: string;
}

/**
 * The `atc_session_spawn` description and its `agent` field description,
 * naming the agents the daemon registered when the tool list was built. Only
 * a registered id appears, and a registered agent whose binary is missing is
 * marked not installed. null leaves every agent unnamed, for a tool list
 * built while the daemon could not answer. Both point at `atc_agents_list`
 * for the current list.
 */
export function buildSpawnDescriptions(
  agents: readonly RegisteredAgent[] | null,
): SpawnDescriptions {
  const roster =
    agents === null
      ? ''
      : ` When this tool list was built, the host registered: ${formatRoster(agents)}.`;

  return {
    tool: `Spawn a new session in a directory. Optional agent is a registered agent id; omitted agent is the host's default agent (claude when it is registered, else the first registered agent), never the TUI last-used value.${roster} atc_agents_list returns the current agents, whether each is installed, and the model and effort each takes. An unregistered agent, a registered agent that is not installed, and a model or effort the agent does not take are refused before anything spawns. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true. Returns the new session descriptor. Give it a prompt to start it working immediately.`,
    agent: `Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent.${roster} atc_agents_list returns the current list.`,
  };
}

function formatRoster(agents: readonly RegisteredAgent[]): string {
  if (agents.length === 0) {
    return 'no agents';
  }

  return agents
    .map((agent) => (agent.installed ? agent.id : `${agent.id} (not installed)`))
    .join(', ');
}
