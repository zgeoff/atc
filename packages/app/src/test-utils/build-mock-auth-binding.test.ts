import { expect, test } from 'bun:test';
import { buildMockAuthBinding } from './build-mock-auth-binding';

test('it builds a default auth binding', () => {
  expect(buildMockAuthBinding()).toStrictEqual({
    agent: 'glm',
    baseURL: expect.toSatisfy((value: string) => URL.canParse(value)),
    profiles: [],
    secrets: [],
    placeholderEnv: {},
    profileEnv: {},
    hash: expect.toSatisfy((value: string) => /^[0-9a-f]{64}$/u.test(value)),
  });
});

test('it applies overrides on top of the defaults, replacing a list whole', () => {
  expect(
    buildMockAuthBinding({
      profiles: ['codex'],
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      profileEnv: { REGION: 'intl' },
    }),
  ).toStrictEqual({
    agent: 'glm',
    baseURL: expect.toBeString(),
    profiles: ['codex'],
    secrets: [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: { REGION: 'intl' },
    hash: expect.toBeString(),
  });
});
