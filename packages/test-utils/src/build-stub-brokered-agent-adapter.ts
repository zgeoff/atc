import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import type { AuthProfile } from '@atc/plugin-api/auth-profile';
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
}

/**
 * An agent adapter for daemon tests that takes the credential of a GLM
 * gateway from impd's broker: the auth profile `glm`, a custom bearer
 * secret `glm` for api.z.ai, behind the gateway at
 * https://api.z.ai/api/anthropic with the placeholder
 * `ANTHROPIC_AUTH_TOKEN`. While `isJudgeSelected` holds, the selection also
 * reaches the profile `judge`, a custom bearer secret `judge` for
 * judge.example. A guest spawn under a binding runs a shell that
 * prints `revision <n>` for the binding's revision and then sleeps, with
 * the binding's variables and `CLAUDE_CONFIG_DIR` set to `claude-config`
 * in the guest folder; a guest spawn without one, and a local spawn, sleep.
 * Its profile is a `GLM` agent of the claude kind run through `sh`, which
 * offers no model or effort choice. Every other member is the plain agent
 * adapter's.
 */
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
            args: ['-c', `echo "revision ${String(guest.auth.revision)}"; exec sleep 30`],
            files: {},
            env: { ...guest.auth.env, CLAUDE_CONFIG_DIR: `${guest.dir}/claude-config` },
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
            placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
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
