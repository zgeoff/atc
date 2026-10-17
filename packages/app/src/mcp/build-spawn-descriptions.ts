export interface RegisteredAgent {
  readonly id: string;
  readonly installed: boolean;
}

interface SpawnDescriptions {
  readonly tool: string;
  readonly agent: string;
}

export function buildSpawnDescriptions(
  agents: readonly RegisteredAgent[] | null,
): SpawnDescriptions {
  const roster =
    agents === null
      ? ''
      : ` When this tool list was built, the host registered: ${formatRoster(agents)}.`;

  return {
    tool: `Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent.${roster} atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes. An unknown or uninstalled agent, an unknown target, an effort outside the agent's values, or a missing or relative cwd is refused before anything starts; a model name goes to the agent CLI unchecked when the agent lists no model values. A workspace or scope refusal can come after atc readied the host, and atc then rolls the spawn back. Called through atc mcp from inside an atc session, the new session is a sub-session unless detached is true: of the caller, or of the caller's parent when the caller is a sub-session itself. It is listed under that parent, pinned and stopped with it, forgettable while it is pinned only by a call from inside it, and reached by a remote client only when the client reaches it. A spawn through atc mcp --http or the gateway, or from a caller atc no longer lists, starts a top-level session. atc_session_update with parent null detaches a sub-session later. A directory the agent has not trusted opens its folder-trust dialog, which atc_terminal_choose answers for Claude Code and a person answers in the TUI for any agent; trustClonedWorkspace trusts a fresh workspace clone. The entry holds warnings when the workspace left changes behind. A retry with the same idempotencyKey and arguments starts no second session: while atc lists the session, it returns the session's current entry without the first call's warnings.`,
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
