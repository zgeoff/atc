import { expect, test } from 'bun:test';
import type { AuthProfile } from '@atc/plugin-api';
import { buildMockAuthProfile } from '@atc/test-utils';
import { resolveAuthProfiles } from './resolve-auth-profiles';

test('it resolves the dependency closure into the complete rule set grouped by secret', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'glm',
      buildMockAuthProfile({
        name: 'glm',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: ['glm-open', 'judge'],
      }),
    ],
    [
      'glm-open',
      buildMockAuthProfile({
        name: 'glm-open',
        secret: 'glm',
        kind: 'custom',
        host: 'open.bigmodel.cn',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
    [
      'judge',
      buildMockAuthProfile({
        name: 'judge',
        secret: 'judge',
        kind: 'custom',
        host: 'judge.example.com',
        header: 'x-api-key',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
    ['unused', buildMockAuthProfile({ name: 'unused' })],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm'])).toStrictEqual({
    resolved: {
      profiles: ['glm', 'glm-open', 'judge'],
      hosts: ['api.z.ai', 'judge.example.com', 'open.bigmodel.cn'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [
            { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
            { host: 'open.bigmodel.cn', header: 'authorization', scheme: 'bearer' },
          ],
        },
        {
          secret: 'judge',
          kind: 'custom',
          rules: [{ host: 'judge.example.com', header: 'x-api-key', scheme: 'bearer' }],
        },
      ],
      env: {},
      envOwners: {},
    },
  });
});

test('it refuses a selection that reaches a profile the config does not declare', () => {
  const profiles = new Map<string, AuthProfile>([
    ['glm', buildMockAuthProfile({ name: 'glm', dependencies: ['judge'] })],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm'])).toStrictEqual({
    problem: {
      code: 'auth_profile_unknown',
      message: 'profile glm depends on judge, but authProfiles has no usable profile by that name',
    },
  });
});

test('it refuses a selected profile the config does not declare', () => {
  expect(resolveAuthProfiles(new Map(), ['glm'])).toStrictEqual({
    problem: {
      code: 'auth_profile_unknown',
      message: 'profile glm is selected, but authProfiles has no usable profile by that name',
    },
  });
});

test('it refuses a dependency cycle', () => {
  const profiles = new Map<string, AuthProfile>([
    ['a', buildMockAuthProfile({ name: 'a', dependencies: ['b'] })],
    ['b', buildMockAuthProfile({ name: 'b', dependencies: ['a'] })],
  ]);

  expect(resolveAuthProfiles(profiles, ['a'])).toStrictEqual({
    problem: {
      code: 'auth_dependency_cycle',
      message: 'profile dependencies form a cycle: a -> b -> a',
    },
  });
});

test('it refuses two profiles that a dependency brings onto one host', () => {
  const profiles = new Map<string, AuthProfile>([
    ['glm', buildMockAuthProfile({ name: 'glm', host: 'api.z.ai', dependencies: ['judge'] })],
    ['judge', buildMockAuthProfile({ name: 'judge', host: 'api.z.ai' })],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm'])).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles glm and judge both send a credential to api.z.ai',
    },
  });
});

test('it refuses two profiles of one secret whose rules differ for one host', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'glm',
      buildMockAuthProfile({
        name: 'glm',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'authorization',
      }),
    ],
    [
      'glm-key',
      buildMockAuthProfile({
        name: 'glm-key',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'x-api-key',
      }),
    ],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm', 'glm-key'])).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles glm and glm-key both send a credential to api.z.ai',
    },
  });
});

test('it merges two profiles that hold the same rule for one host into one rule', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'glm',
      buildMockAuthProfile({
        name: 'glm',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
    [
      'glm-again',
      buildMockAuthProfile({
        name: 'glm-again',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm', 'glm-again'])).toStrictEqual({
    resolved: {
      profiles: ['glm', 'glm-again'],
      hosts: ['api.z.ai'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      env: {},
      envOwners: {},
    },
  });
});

test('it resolves a 40-profile chain where each profile depends on every profile before it', () => {
  const names = Array.from({ length: 40 }, (_, index) => `p${String(index).padStart(2, '0')}`);

  const result = resolveAuthProfiles(
    new Map(
      names.map((name, index) => [
        name,
        buildMockAuthProfile({
          name,
          secret: name,
          kind: 'custom',
          host: `${name}.example.com`,
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: names.slice(0, index),
        }),
      ]),
    ),
    ['p39'],
  );

  expect(result).toStrictEqual({
    resolved: {
      profiles: names,
      hosts: names.map((name) => `${name}.example.com`),
      secrets: names.map((name) => ({
        secret: name,
        kind: 'custom',
        rules: [{ host: `${name}.example.com`, header: 'authorization', scheme: 'bearer' }],
      })),
      env: {},
      envOwners: {},
    },
  });
});

test('it resolves a github profile to a github secret with no rules beside a custom profile', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'glm',
      buildMockAuthProfile({
        name: 'glm',
        secret: 'glm',
        kind: 'custom',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
    [
      'github',
      buildMockAuthProfile({
        kind: 'github',
        name: 'github',
        secret: 'github-agents',
        env: {},
        dependencies: [],
      }),
    ],
  ]);

  expect(resolveAuthProfiles(profiles, ['glm', 'github'])).toStrictEqual({
    resolved: {
      profiles: ['github', 'glm'],
      hosts: ['api.z.ai'],
      secrets: [
        { secret: 'github-agents', kind: 'github', rules: [] },
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      env: {},
      envOwners: {},
    },
  });
});

test('it resolves a custom profile on a github host beside a github profile, whose hosts the broker holds', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'gh-api',
      buildMockAuthProfile({
        name: 'gh-api',
        secret: 'gh-api',
        kind: 'custom',
        host: 'api.github.com',
        header: 'authorization',
        scheme: 'bearer',
        env: {},
        dependencies: [],
      }),
    ],
    [
      'github',
      buildMockAuthProfile({
        kind: 'github',
        name: 'github',
        secret: 'github-agents',
        env: {},
        dependencies: [],
      }),
    ],
  ]);

  expect(resolveAuthProfiles(profiles, ['github', 'gh-api'])).toStrictEqual({
    resolved: {
      profiles: ['gh-api', 'github'],
      hosts: ['api.github.com'],
      secrets: [
        {
          secret: 'gh-api',
          kind: 'custom',
          rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
        },
        { secret: 'github-agents', kind: 'github', rules: [] },
      ],
      env: {},
      envOwners: {},
    },
  });
});

test('it refuses two profiles that bind one secret as different kinds', () => {
  const profiles = new Map<string, AuthProfile>([
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github', secret: 'shared' })],
    ['judge', buildMockAuthProfile({ name: 'judge', secret: 'shared' })],
  ]);

  expect(resolveAuthProfiles(profiles, ['github', 'judge'])).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles github and judge bind secret shared as different kinds',
    },
  });
});

test('it merges the variables of every reached profile with the profile that sets each', () => {
  const profileA = buildMockAuthProfile({ name: 'a', env: { TOKEN: 'broker-placeholder' } });

  const profileB = buildMockAuthProfile({
    name: 'b',
    env: { TOKEN: 'broker-placeholder', B_HOST: 'https://b.example.com' },
  });

  const profiles = new Map([
    ['a', profileA],
    ['b', profileB],
  ]);

  expect(resolveAuthProfiles(profiles, ['b', 'a'])).toStrictEqual({
    resolved: {
      profiles: ['a', 'b'],
      hosts: expect.toIncludeSameMembers([profileA.host, profileB.host]),
      secrets: expect.toIncludeSameMembers([
        {
          secret: profileA.secret,
          kind: 'custom',
          rules: [{ host: profileA.host, header: profileA.header, scheme: 'bearer' }],
        },
        {
          secret: profileB.secret,
          kind: 'custom',
          rules: [{ host: profileB.host, header: profileB.header, scheme: 'bearer' }],
        },
      ]),
      env: { TOKEN: 'broker-placeholder', B_HOST: 'https://b.example.com' },
      envOwners: { TOKEN: 'a', B_HOST: 'b' },
    },
  });
});

test('it refuses two profiles that set one variable to different values', () => {
  const profiles = new Map<string, AuthProfile>([
    ['a', buildMockAuthProfile({ name: 'a', env: { SERVICE_URL: 'https://a.example.com' } })],
    ['b', buildMockAuthProfile({ name: 'b', env: { SERVICE_URL: 'https://b.example.com' } })],
  ]);

  expect(resolveAuthProfiles(profiles, ['b', 'a'])).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles a and b set SERVICE_URL to different values',
    },
  });
});
