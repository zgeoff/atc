import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

export function buildStubBrokeredGatewayAdapter(): AgentAdapter {
  return buildMockAgentAdapter({
    id: 'glm',
    planGuestSpawn: (_opts, guest) => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { ...guest.auth?.env, CLAUDE_CONFIG_DIR: `${guest.directory}/claude-config` },
    }),
    findAuthSelection: () => ({
      brokerRequired: true,
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        },
      },
      profiles: new Map([
        [
          'glm',
          {
            name: 'glm',
            secret: 'glm',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
    }),
  });
}
