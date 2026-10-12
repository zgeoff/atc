import type { AgentAdapter } from '../agents/agent-adapter';
import { buildStubBrokeredAgentAdapter } from './build-stub-brokered-agent-adapter';

interface StubProxiedAgentAdapterConfig {
  readonly id: string;
}

/**
 * An agent adapter for daemon tests that takes the GLM credential from
 * impd's broker, as the brokered stand-in does, and that always starts
 * behind the broker, but whose guest spawn plans a proxy variable of its
 * own: `https_proxy` set to http://proxy.example:3128, beside a `sleep 30`.
 * Every other member is the brokered stand-in's.
 */
export function buildStubProxiedAgentAdapter(config: StubProxiedAgentAdapterConfig): AgentAdapter {
  return {
    ...buildStubBrokeredAgentAdapter({
      id: config.id,
      brokerRequired: true,
      isSelected: () => true,
    }),
    planGuestSpawn: () => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { https_proxy: 'http://proxy.example:3128' },
    }),
  };
}
