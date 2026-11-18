import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';

export function buildStubAttentionAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return buildMockAgentAdapter({
    takesMessages: true,
    planHookEvents: (hook) => ({
      events: [{ kind: hook.event === 'Notification' ? 'needs-input' : 'prompt-submitted' }],
    }),
    planResumeCommand: () => 'claude --resume',
    ...overrides,
  });
}
