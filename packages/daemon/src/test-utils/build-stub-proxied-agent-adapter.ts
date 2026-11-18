import type { AgentAdapter } from '@atc/plugin-api';
import { buildStubBrokeredAgentAdapter } from './build-stub-brokered-agent-adapter';

interface StubProxiedAgentAdapterConfig {
  readonly id: string;
}

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
