import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';

/**
 * An agent adapter for daemon tests: id `claude`, a spawn that runs
 * `sleep 30` so the session stays alive with no agent CLI behind it, every
 * hook read as one heartbeat that keeps no state, no name, no resume command, no headless runner,
 * no screen detector, and no inbox messages. Every optional member is
 * absent, so the daemon takes the stand-in path for each one, and
 * `agents.list` reports the adapter as not installed. An override replaces
 * the member it names.
 */
export function buildMockAgentAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    planHookEvents: () => ({ events: [{ kind: 'heartbeat' }] }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
    ...overrides,
  };
}
