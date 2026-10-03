import { expect, test } from 'bun:test';
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
    },
  });
});
