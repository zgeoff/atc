import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

export function buildStubAttentionAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return buildMockAgentAdapter({
    takesMessages: true,
    planHookEvents: (hook) => ({
      events: [{ kind: hook.event === 'Notification' ? 'needs-input' : 'prompt-submitted' }],
    }),
    buildResumeCommand: () => 'claude --resume',
    ...overrides,
  });
}
