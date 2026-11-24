interface MockAgent {
  readonly id: string;
  readonly installed: boolean;
}

const UNSUPPORTED_OPTION = {
  supported: false,
  available: false,
  values: null,
  examples: [],
  default: null,
  backendEffect: null,
  note: null,
};

// An agents.list answer that holds the given agents, as one daemon sends it.
export function buildMockAgentList(
  agents: readonly MockAgent[],
): Readonly<Record<string, unknown>> {
  return {
    daemon: { hostname: 'host', platform: 'linux', arch: 'x64', build: 'atc/test-build' },
    agents: agents.map((agent) => ({
      id: agent.id,
      label: agent.id,
      kind: agent.id,
      installed: agent.installed,
      brokerAuth: false,
      brokerRequired: false,
      spawnTargets: [],
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: UNSUPPORTED_OPTION,
        effort: UNSUPPORTED_OPTION,
        pluginDirs: UNSUPPORTED_OPTION,
      },
    })),
    targets: [],
    spawnDefaults: { agent: agents[0]?.id ?? 'claude', target: null },
    configRevision: 'r-1',
    targetErrors: [],
    sources: [],
  };
}
