import { expect, test } from 'bun:test';
import { collectAuthProfiles } from './collect-auth-profiles';
import { resolveAuthProfiles } from './resolve-auth-profiles';

test('it resolves the dependency closure into the complete rule set grouped by secret', () => {
  expect(
    resolveAuthProfiles(
      new Map([
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
            dependencies: ['glm-open', 'judge'],
          },
        ],
        [
          'glm-open',
          {
            name: 'glm-open',
            secret: 'glm',
            kind: 'custom',
            host: 'open.bigmodel.cn',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
        [
          'judge',
          {
            name: 'judge',
            secret: 'judge',
            kind: 'custom',
            host: 'judge.example.com',
            header: 'x-api-key',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
        [
          'unused',
          {
            name: 'unused',
            secret: 'other',
            kind: 'custom',
            host: 'other.example.com',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['glm'],
    ),
  ).toStrictEqual({
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
  expect(
    resolveAuthProfiles(
      new Map([
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
            dependencies: ['judge'],
          },
        ],
      ]),
      ['glm'],
    ),
  ).toStrictEqual({
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
  expect(
    resolveAuthProfiles(
      new Map([
        [
          'a',
          {
            name: 'a',
            secret: 'a',
            kind: 'custom',
            host: 'a.example.com',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: ['b'],
          },
        ],
        [
          'b',
          {
            name: 'b',
            secret: 'b',
            kind: 'custom',
            host: 'b.example.com',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: ['a'],
          },
        ],
      ]),
      ['a'],
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_dependency_cycle',
      message: 'profile dependencies form a cycle: a -> b -> a',
    },
  });
});

test('it refuses two profiles that a dependency brings onto one host', () => {
  expect(
    resolveAuthProfiles(
      new Map([
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
            dependencies: ['judge'],
          },
        ],
        [
          'judge',
          {
            name: 'judge',
            secret: 'judge',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['glm'],
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles glm and judge both send a credential to api.z.ai',
    },
  });
});

test('it refuses two profiles of one secret whose rules differ for one host', () => {
  expect(
    resolveAuthProfiles(
      new Map([
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
        [
          'glm-key',
          {
            name: 'glm-key',
            secret: 'glm',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'x-api-key',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['glm', 'glm-key'],
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles glm and glm-key both send a credential to api.z.ai',
    },
  });
});

test('it merges two profiles that hold the same rule for one host into one rule', () => {
  expect(
    resolveAuthProfiles(
      new Map([
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
        [
          'glm-again',
          {
            name: 'glm-again',
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
      ['glm', 'glm-again'],
    ),
  ).toStrictEqual({
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

test('it resolves a deep chain of shared dependencies in one visit per profile', () => {
  const names = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);

  const result = resolveAuthProfiles(
    new Map(
      names.map((name, i) => [
        name,
        {
          name,
          secret: name,
          kind: 'custom' as const,
          host: `${name}.example.com`,
          header: 'authorization',
          scheme: 'bearer' as const,
          env: {},
          dependencies: names.slice(0, i),
        },
      ]),
    ),
    [names.at(-1) ?? ''],
  );

  expect(result).toMatchObject({ resolved: { profiles: names } });
});

test('it expands a github profile into the rules of the github kind beside a custom profile', () => {
  expect(
    resolveAuthProfiles(
      new Map([
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
        [
          'github',
          {
            name: 'github',
            secret: 'github-imp-agents',
            kind: 'github',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['glm', 'github'],
    ),
  ).toStrictEqual({
    resolved: {
      profiles: ['github', 'glm'],
      hosts: ['api.github.com', 'api.z.ai', 'github.com', 'uploads.github.com'],
      secrets: [
        {
          secret: 'github-imp-agents',
          kind: 'github',
          rules: [
            { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
            {
              host: 'github.com',
              header: 'authorization',
              scheme: 'basic',
              user: 'x-access-token',
            },
            { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
          ],
        },
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

test('it refuses a custom profile on a host a github profile covers', () => {
  expect(
    resolveAuthProfiles(
      new Map([
        [
          'gh-api',
          {
            name: 'gh-api',
            secret: 'other',
            kind: 'custom',
            host: 'api.github.com',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
        [
          'github',
          {
            name: 'github',
            secret: 'github-imp-agents',
            kind: 'github',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['github', 'gh-api'],
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles gh-api and github both send a credential to api.github.com',
    },
  });
});

test('it refuses two profiles that bind one secret as different kinds', () => {
  expect(
    resolveAuthProfiles(
      new Map([
        ['github', { name: 'github', secret: 'shared', kind: 'github', env: {}, dependencies: [] }],
        [
          'judge',
          {
            name: 'judge',
            secret: 'shared',
            kind: 'custom',
            host: 'judge.example.com',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
      ['github', 'judge'],
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles github and judge bind secret shared as different kinds',
    },
  });
});

function collectEnvProfiles(
  hosts: Readonly<Record<string, string>>,
  envs: Readonly<Record<string, Readonly<Record<string, string>>>>,
) {
  return collectAuthProfiles(
    Object.fromEntries(
      Object.entries(hosts).map(([name, host]) => [
        name,
        { secret: name, host, header: 'authorization', scheme: 'bearer', env: envs[name] },
      ]),
    ),
  ).profiles;
}

test('it merges the variables of every reached profile with the profile that sets each', () => {
  const profiles = collectEnvProfiles(
    { a: 'a.example.com', b: 'b.example.com' },
    {
      a: { TOKEN: 'imp-broker-placeholder' },
      b: { TOKEN: 'imp-broker-placeholder', B_HOST: 'https://b.example.com' },
    },
  );

  expect(resolveAuthProfiles(profiles, ['b', 'a'])).toMatchObject({
    resolved: {
      env: { TOKEN: 'imp-broker-placeholder', B_HOST: 'https://b.example.com' },
      envOwners: { TOKEN: 'a', B_HOST: 'b' },
    },
  });
});

test('it refuses two profiles that set one variable to different values', () => {
  const profiles = collectEnvProfiles(
    { a: 'a.example.com', b: 'b.example.com' },
    { a: { SERVICE_URL: 'https://a.example.com' }, b: { SERVICE_URL: 'https://b.example.com' } },
  );

  expect(resolveAuthProfiles(profiles, ['b', 'a'])).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles a and b set SERVICE_URL to different values',
    },
  });
});
