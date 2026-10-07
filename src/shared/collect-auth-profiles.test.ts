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
        env: {},
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
          host: 'judge.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
    errors: [],
  });
});

test('it reads a github profile into its secret reference alone, since impd fixes its rules', () => {
  expect(
    collectAuthProfiles({
      github: { secret: 'github-imp-agents', kind: 'github' },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'github',
        { name: 'github', secret: 'github-imp-agents', kind: 'github', env: {}, dependencies: [] },
      ],
    ]),
    errors: [],
  });
});

test.each([
  [
    { host: 'github.com' },
    "authProfiles.p: host cannot be set on a github profile, whose hosts and headers impd's github kind fixes",
  ],
  [
    { header: 'authorization' },
    "authProfiles.p: header cannot be set on a github profile, whose hosts and headers impd's github kind fixes",
  ],
  [
    { scheme: 'basic' },
    "authProfiles.p: scheme cannot be set on a github profile, whose hosts and headers impd's github kind fixes",
  ],
  [
    { user: 'x-access-token' },
    "authProfiles.p: user cannot be set on a github profile, whose hosts and headers impd's github kind fixes",
  ],
  [{ dependencies: 'glm' }, 'authProfiles.p: dependencies must be an array of profile names'],
])('it refuses a github profile with %p', (override, error) => {
  expect(
    collectAuthProfiles({ p: { secret: 'github-imp-agents', kind: 'github', ...override } }),
  ).toStrictEqual({ profiles: new Map(), errors: [error] });
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
  [{ kind: 'anthropic' }, 'authProfiles.p: kind must be custom or github, the kinds atc binds'],
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
          env: {},
          dependencies: [],
        },
      ],
    ]),
    errors: ['authProfiles.bad: a profile must be an object'],
  });
});

const OP_CONNECT = {
  secret: 'op-connect',
  host: 'op-connect.geoff.cloud',
  header: 'authorization',
  scheme: 'bearer',
} as const;

test('it keeps the variables of a custom profile set to the placeholder or its own host', () => {
  const env = {
    OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
    OP_CONNECT_TOKEN: 'imp-broker-placeholder',
  };

  expect(collectAuthProfiles({ op: { ...OP_CONNECT, env } })).toStrictEqual({
    profiles: new Map([
      ['op', { name: 'op', ...OP_CONNECT, kind: 'custom', env, dependencies: [] }],
    ]),
    errors: [],
  });
});

test('it gives a profile that sets no variables an empty env', () => {
  expect(collectAuthProfiles({ op: OP_CONNECT }).profiles.get('op')).toHaveProperty('env', {});
});

test.each([
  [
    { X_URL: 'https://other.example.com' },
    'env.X_URL must be imp-broker-placeholder or https://op-connect.geoff.cloud',
  ],
  [
    { X_URL: 'https://op-connect.geoff.cloud/v1' },
    'env.X_URL must be imp-broker-placeholder or https://op-connect.geoff.cloud',
  ],
  [
    { X_URL: 'https://op-connect.geoff.cloud:8443' },
    'env.X_URL must be imp-broker-placeholder or https://op-connect.geoff.cloud',
  ],
  [
    { X_URL: 'http://op-connect.geoff.cloud' },
    'env.X_URL must be imp-broker-placeholder or https://op-connect.geoff.cloud',
  ],
  [
    { X_TOKEN: 'a-real-looking-token' },
    'env.X_TOKEN must be imp-broker-placeholder or https://op-connect.geoff.cloud',
  ],
  [{ X_TOKEN: 7 }, 'env.X_TOKEN must be imp-broker-placeholder or https://op-connect.geoff.cloud'],
  [
    { lower: 'imp-broker-placeholder' },
    'env.lower is not a variable name: use capital letters, digits and underscores',
  ],
  [
    { '1X': 'imp-broker-placeholder' },
    'env.1X is not a variable name: use capital letters, digits and underscores',
  ],
  ['x', 'env must be an object of variable names'],
])('it refuses a profile whose env is %p', (env, error) => {
  expect(collectAuthProfiles({ op: { ...OP_CONNECT, env } })).toStrictEqual({
    profiles: new Map(),
    errors: [`authProfiles.op: ${error}`],
  });
});

test.each([
  'HTTPS_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_ANYTHING',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ATC_SESSION_ID',
  'PATH',
  'HOME',
])('it refuses a profile that sets the reserved variable %s', (name) => {
  expect(
    collectAuthProfiles({ op: { ...OP_CONNECT, env: { [name]: 'imp-broker-placeholder' } } }),
  ).toStrictEqual({
    profiles: new Map(),
    errors: [`authProfiles.op: env.${name} cannot be set: atc or impd sets or reserves it`],
  });
});

test('it refuses env on a github profile', () => {
  expect(
    collectAuthProfiles({
      p: { secret: 'github-imp-agents', kind: 'github', env: { X: 'imp-broker-placeholder' } },
    }),
  ).toStrictEqual({
    profiles: new Map(),
    errors: [
      "authProfiles.p: env cannot be set on a github profile, whose placeholders impd's github kind sets",
    ],
  });
});
