import { expect, test } from 'bun:test';
import { buildStubBrokeredAgentAdapter } from './build-stub-brokered-agent-adapter';

test('it plans a guest spawn under a binding that prints the revision behind its variables', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: null,
      dir: '/guest/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan).toStrictEqual({
    bin: 'sh',
    args: ['-c', 'echo "revision 3"; exec sleep 30'],
    files: {},
    env: {
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CONFIG_DIR: '/guest/sessions/s1/claude-config',
    },
  });
});

test('it plans a guest spawn without a binding that only sleeps', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    { atc: null, dir: '/guest/sessions/s1' },
  );

  expect(plan).toStrictEqual({ bin: 'sleep', args: ['30'], files: {} });
});

test('it selects the glm gateway credential with the broker requirement it is given', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'subscription',
    brokerRequired: false,
    isSelected: () => true,
  });

  expect(adapter.findAuthSelection?.()).toStrictEqual({
    brokerRequired: false,
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
  });
});

test('it selects no credential while the selection is off', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => false,
  });

  expect(adapter.findAuthSelection?.()).toBeNull();
});

test('it takes the id it is given and sleeps on a local spawn', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'proxied',
    brokerRequired: true,
    isSelected: () => true,
  });

  expect(adapter.id).toBe('proxied');

  expect(adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'sleep',
    args: ['30'],
  });
});

test('it reports a GLM profile of the claude kind that offers no model or effort', () => {
  const adapter = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  expect(adapter.profile).toStrictEqual({
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
  });
});
