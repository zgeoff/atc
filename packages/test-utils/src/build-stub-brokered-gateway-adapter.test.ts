import { expect, test } from 'bun:test';
import { buildStubBrokeredGatewayAdapter } from './build-stub-brokered-gateway-adapter';

test('it plans a guest spawn under a binding that sleeps behind the binding variables', () => {
  const adapter = buildStubBrokeredGatewayAdapter();

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
    bin: 'sleep',
    args: ['30'],
    files: {},
    env: {
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CONFIG_DIR: '/guest/sessions/s1/claude-config',
    },
  });
});

test('it plans a guest spawn without a binding that sleeps with only its config folder set', () => {
  const adapter = buildStubBrokeredGatewayAdapter();

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    { atc: null, dir: '/guest/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'sleep',
    args: ['30'],
    files: {},
    env: { CLAUDE_CONFIG_DIR: '/guest/sessions/s1/claude-config' },
  });
});

test('it selects the glm gateway credential and requires the broker', () => {
  const adapter = buildStubBrokeredGatewayAdapter();

  expect(adapter.findAuthSelection?.()).toStrictEqual({
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
  });
});

test('it keeps the id glm', () => {
  expect(buildStubBrokeredGatewayAdapter().id).toBe('glm');
});
