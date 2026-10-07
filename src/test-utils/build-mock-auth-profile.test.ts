import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from './build-mock-auth-profile';

test('it builds a default auth profile', () => {
  expect(buildMockAuthProfile()).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    secret: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    kind: 'custom',
    host: expect.toBeString(),
    header: expect.toSatisfy((value: string) => /^x-[a-z]{6}-key$/u.test(value)),
    scheme: 'bearer',
    env: {},
    dependencies: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockAuthProfile({
      name: 'glm',
      host: 'api.z.ai',
      env: { ZAI_REGION: 'intl' },
      dependencies: ['github'],
    }),
  ).toStrictEqual({
    name: 'glm',
    secret: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    kind: 'custom',
    host: 'api.z.ai',
    header: expect.toSatisfy((value: string) => /^x-[a-z]{6}-key$/u.test(value)),
    scheme: 'bearer',
    env: { ZAI_REGION: 'intl' },
    dependencies: ['github'],
  });
});

test('it builds a github profile for an override of that kind', () => {
  expect(buildMockAuthProfile({ kind: 'github', name: 'gh' })).toStrictEqual({
    name: 'gh',
    secret: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    kind: 'github',
    env: {},
    dependencies: [],
  });
});
