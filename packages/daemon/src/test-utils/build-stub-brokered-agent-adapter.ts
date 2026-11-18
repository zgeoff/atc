import type { AgentAdapter, AuthProfile } from '@atc/plugin-api';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

interface StubBrokeredAgentAdapterConfig {
  readonly id: string;

  // Whether the agent starts only behind the broker; false lets it start
  // on a target that reaches no broker.
  readonly brokerRequired: boolean;

  // Whether the agent takes its credential from the broker at the moment
  // of the call, as a config change can turn it on or off for an agent
  // whose sessions already exist.
  readonly isSelected: () => boolean;

  // Whether the gateway's selection also reaches the profile `judge` at
  // the moment of the call, as a config change can add or drop a profile
  // for an agent whose sessions already exist. Absent reaches only `glm`.
  readonly isJudgeSelected?: () => boolean;

  // Whether a guest spawn under a binding planned at the moment of the call
  // ignores the hangup signal a kill sends, so its kill never confirms an
  // exit. Absent plans a shell that exits on it.
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
