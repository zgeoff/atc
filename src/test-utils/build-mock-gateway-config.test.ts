import { expect, test } from 'bun:test';
import { buildMockGatewayConfig } from './build-mock-gateway-config';

test('it builds a default gateway config', () => {
  expect(buildMockGatewayConfig()).toStrictEqual({
    id: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    label: expect.toBeString(),
    mark: expect.toSatisfy((value: string) => /^[a-z]$/u.test(value)),
    bin: expect.toBeString(),
    args: [],
    baseURL: expect.toSatisfy((value: string) => URL.canParse(value)),
    env: {},
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockGatewayConfig({
      id: 'zai',
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_MODEL: 'glm-4.6' },
      apiKeyHelper: 'echo key',
    }),
  ).toStrictEqual({
    id: 'zai',
    label: expect.toBeString(),
    mark: expect.toSatisfy((value: string) => /^[a-z]$/u.test(value)),
    bin: expect.toBeString(),
    args: [],
    baseURL: 'https://api.z.ai/api/anthropic',
    env: { ANTHROPIC_MODEL: 'glm-4.6' },
    apiKeyHelper: 'echo key',
  });
});
