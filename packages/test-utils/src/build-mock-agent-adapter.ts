import type { AgentAdapter } from '@atc/plugin-api';

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
