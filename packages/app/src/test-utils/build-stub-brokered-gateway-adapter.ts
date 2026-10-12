import type { AgentAdapter } from '../agents/agent-adapter';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

/**
 * An agent adapter `glm` for daemon tests that only starts behind impd's
 * broker and takes the credential of a GLM gateway from it: the auth
 * profile `glm`, a custom bearer secret `glm` for api.z.ai, behind the
 * gateway at https://api.z.ai/api/anthropic with the placeholder
 * `ANTHROPIC_AUTH_TOKEN`. Every guest spawn sleeps, with the binding's
 * variables, when it has one, and `CLAUDE_CONFIG_DIR` set to
 * `claude-config` in the guest folder. Every other member is the plain
 * agent adapter's.
 */
export function buildStubBrokeredGatewayAdapter(): AgentAdapter {
  return buildMockAgentAdapter({
    id: 'glm',
    planGuestSpawn: (_opts, guest) => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { ...guest.auth?.env, CLAUDE_CONFIG_DIR: `${guest.dir}/claude-config` },
    }),
    findAuthSelection: () => ({
      brokerRequired: true,
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
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
