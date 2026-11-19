import type { AgentAdapter, AuthProfile } from '@atc/plugin-api';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';

interface StubBrokeredAgentAdapterConfig {
  readonly id: string;

  readonly brokerRequired: boolean;

  // Read at each call, not once, because a config change can turn it on or off for an agent
  // whose sessions already exist.
  readonly isSelected: () => boolean;

  // Read at each call, not once, because a config change can add or drop the judge profile for an
  // agent whose sessions already exist. Absent selects only glm.
  readonly isJudgeSelected?: () => boolean;

  // Read at each spawn, not once. A guest that ignores hangup never confirms an exit after a kill.
  // Absent plans a shell that exits on it.
  readonly ignoresHangup?: () => boolean;
}

export function buildStubBrokeredAgentAdapter(
  config: StubBrokeredAgentAdapterConfig,
): AgentAdapter {
  return buildMockAgentAdapter({
    id: config.id,
    profile: {
      label: 'GLM',
      kind: 'claude',
      bin: 'sh',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    planGuestSpawn: (_opts, guest) =>
      guest.auth === undefined
        ? { bin: 'sleep', args: ['30'], files: {} }
        : {
            bin: 'sh',
            args: [
              '-c',
              `${config.ignoresHangup?.() === true ? "trap '' HUP; " : ''}echo "revision ${String(guest.auth.revision)}"; exec sleep 30`,
            ],
            files: {},
            env: { ...guest.auth.env, CLAUDE_CONFIG_DIR: `${guest.directory}/claude-config` },
          },
    findAuthSelection: () => {
      if (!config.isSelected()) {
        return null;
      }

      const hasJudge = config.isJudgeSelected?.() ?? false;

      return {
        brokerRequired: config.brokerRequired,
        gateway: {
          id: 'glm',
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: {
            profiles: hasJudge ? ['glm', 'judge'] : ['glm'],
            placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
          },
        },
        profiles: new Map<string, AuthProfile>([
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
          ...(hasJudge
            ? [
                [
                  'judge',
                  {
                    name: 'judge',
                    secret: 'judge',
                    kind: 'custom',
                    host: 'judge.example',
                    header: 'authorization',
                    scheme: 'bearer',
                    env: {},
                    dependencies: [],
                  },
                ] as const,
              ]
            : []),
        ]),
      };
    },
  });
}
