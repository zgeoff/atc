import { expect, test } from 'bun:test';
import { buildMockAgentEntry } from './build-mock-agent-entry';

test('it builds a default agent entry', () => {
  expect(buildMockAgentEntry()).toStrictEqual({
    id: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    kind: 'claude',
    label: expect.toBeString(),
    mark: expect.toSatisfy((value: string) => /^[a-z]$/u.test(value)),
    bin: expect.toBeString(),
    args: [],
    env: {},
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockAgentEntry({
      id: 'zai',
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_MODEL: 'glm-4.6' },
      auth: { profiles: ['glm'], placeholderEnv: {} },
    }),
  ).toStrictEqual({
    id: 'zai',
    kind: 'claude',
    label: expect.toBeString(),
    mark: expect.toSatisfy((value: string) => /^[a-z]$/u.test(value)),
    bin: expect.toBeString(),
    args: [],
    env: { ANTHROPIC_MODEL: 'glm-4.6' },
    baseURL: 'https://api.z.ai/api/anthropic',
    auth: { profiles: ['glm'], placeholderEnv: {} },
  });
});
