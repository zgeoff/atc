import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

/**
 * An agent adapter for daemon tests whose hooks report attention: id
 * `claude`, a spawn that runs `sleep 30`, sessions that take inbox
 * messages, a `Notification` hook read as needing input and every other
 * hook as a submitted prompt, and `claude --resume` as the resume command.
 * It reads nothing from a hook's payload, so a payload's session id binds
 * nothing. Every other member is the mock adapter's. An override replaces
 * the member it names.
 */
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
