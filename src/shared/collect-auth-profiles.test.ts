import { expect, test } from 'bun:test';
import { collectAuthProfiles } from './collect-auth-profiles';

test('it reads a profile into its secret reference and the rule impd applies for its host', () => {
  expect(
    collectAuthProfiles({
      glm: {
        secret: 'glm',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        dependencies: ['judge'],
      },
      judge: {
        secret: 'judge',
        host: 'judge.example.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    }),
  ).toStrictEqual({
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
          dependencies: ['judge'],
        },
      ],
      [
        'judge',
        {
          name: 'judge',
          secret: 'judge',
          kind: 'custom',
          host: 'judge.example.com',
          header: 'authorization',
          scheme: 'bearer',
          dependencies: [],
        },
      ],
    ]),
    errors: [],
  });
});

test('it holds no profiles and no errors when the config sets none', () => {
  expect(collectAuthProfiles(undefined)).toStrictEqual({ profiles: new Map(), errors: [] });
});

test('it refuses an authProfiles value that is not an object of named profiles', () => {
  expect(collectAuthProfiles(['glm'])).toStrictEqual({
    profiles: new Map(),
    errors: ['authProfiles must be an object of named profiles'],
  });
});

test.each([
  [{ kind: 'anthropic' }, 'authProfiles.p: kind must be custom, the one kind atc binds'],
  [{ scheme: 'raw' }, 'authProfiles.p: scheme must be bearer, the one scheme atc binds'],
  [{ scheme: 'basic' }, 'authProfiles.p: scheme must be bearer, the one scheme atc binds'],
  [
    { user: 'me' },
    'authProfiles.p: user pairs only with the basic scheme, which atc does not bind',
  ],
  [
    { secret: 'GLM' },
    'authProfiles.p: secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ],
  [
    { host: 'API.z.ai' },
    'authProfiles.p: host must be a lowercase hostname such as api.example.com',
  ],
  [{ host: '*.z.ai' }, 'authProfiles.p: host must be a lowercase hostname such as api.example.com'],
  [
    { host: '10.0.0.1' },
    'authProfiles.p: host must be a lowercase hostname such as api.example.com',
  ],
  [
    { host: 'api.z.ai:443' },
    'authProfiles.p: host must be a lowercase hostname such as api.example.com',
  ],
  [
    { header: 'Authorization' },
    'authProfiles.p: header must be a lowercase header name such as authorization',
  ],
  [{ dependencies: 'judge' }, 'authProfiles.p: dependencies must be an array of profile names'],
  [
    { dependencies: ['judge', 3] },
    'authProfiles.p: dependencies must be an array of profile names',
  ],
])('it refuses a profile with %p', (override, error) => {
  expect(
    collectAuthProfiles({
      p: {
        secret: 'glm',
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer',
        ...override,
      },
    }),
  ).toStrictEqual({ profiles: new Map(), errors: [error] });
});

test('it refuses a profile that is not an object, and keeps its well-formed siblings', () => {
  expect(
    collectAuthProfiles({
      bad: 'glm',
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    }),
  ).toStrictEqual({
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
          dependencies: [],
        },
      ],
    ]),
    errors: ['authProfiles.bad: a profile must be an object'],
  });
});
