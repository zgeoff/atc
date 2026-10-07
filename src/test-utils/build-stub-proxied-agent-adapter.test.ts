import { expect, test } from 'bun:test';
import { buildStubProxiedAgentAdapter } from './build-stub-proxied-agent-adapter';

test('it plans a guest spawn that sets a proxy variable under a binding', () => {
  const adapter = buildStubProxiedAgentAdapter({ id: 'proxied' });

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: null,
      dir: '/guest/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan).toStrictEqual({
    bin: 'sleep',
    args: ['30'],
    files: {},
    env: { https_proxy: 'http://proxy.example:3128' },
  });
});

test('it selects the glm gateway credential that requires the broker', () => {
  const adapter = buildStubProxiedAgentAdapter({ id: 'proxied' });

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

test('it takes the id it is given', () => {
  const adapter = buildStubProxiedAgentAdapter({ id: 'proxied' });

  expect(adapter.id).toBe('proxied');
});
