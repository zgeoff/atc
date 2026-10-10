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
 * built while the daemon could not answer. Both point at `atc_spawn_options_get`
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
    tool: `Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent.${roster} atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes, and anything else is refused before anything starts. Called from inside an atc session, the new session is a sub-session of the caller (listed under it, stopped with it) unless detached is true. A directory the agent has not trusted opens its folder-trust dialog, which only a person can answer in the TUI; trustClonedWorkspace trusts a fresh workspace clone. A retry with the same idempotencyKey and arguments returns the first result.`,
    agent: `Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent.${roster} atc_spawn_options_get returns the current list.`,
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
