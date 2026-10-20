import { expect, test } from 'bun:test';
import { collectAuthProfiles } from './collect-auth-profiles';

test('it reads a profile into its secret reference and the rule the broker applies for its host', () => {
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

test("it reads a github profile into its secret reference alone, since the broker's github secret holds its rules", () => {
  expect(
    collectAuthProfiles({
      github: { secret: 'github-agents', kind: 'github' },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'github',
        { name: 'github', secret: 'github-agents', kind: 'github', env: {}, dependencies: [] },
      ],
    ]),
    errors: [],
  });
});

test('it reads a profile whose rule sets a raw x-api-key header', () => {
  expect(
    collectAuthProfiles({
      muse: { secret: 'muse', host: 'api.meta.ai', header: 'x-api-key', scheme: 'raw' },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'muse',
        {
          name: 'muse',
          secret: 'muse',
          kind: 'custom',
          host: 'api.meta.ai',
          header: 'x-api-key',
          scheme: 'raw',
          env: {},
          dependencies: [],
        },
      ],
    ]),
    errors: [],
  });
});

test('it reads an oauth profile with the same rule as a custom one', () => {
  expect(
    collectAuthProfiles({
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'codex',
        {
          name: 'codex',
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
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

test.each([
  [
    { host: undefined },
    'authProfiles.glm: host must be a lowercase hostname such as api.example.com',
  ],
  [{ scheme: 'basic' }, 'authProfiles.glm: scheme must be bearer or raw, the schemes atc binds'],
  [{ header: '' }, 'authProfiles.glm: header must be a header name such as authorization'],
])('it refuses an oauth profile with %p', (override, error) => {
  expect(
    collectAuthProfiles({
      glm: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
        ...override,
      },
    }),
  ).toStrictEqual({ profiles: new Map(), errors: [error] });
});

test.each([
  [
    { host: 'github.com' },
    "authProfiles.glm: host cannot be set on a github profile, whose hosts and headers the broker's github secret fixes",
  ],
  [
    { header: 'authorization' },
    "authProfiles.glm: header cannot be set on a github profile, whose hosts and headers the broker's github secret fixes",
  ],
  [
    { scheme: 'basic' },
    "authProfiles.glm: scheme cannot be set on a github profile, whose hosts and headers the broker's github secret fixes",
  ],
  [
    { user: 'x-access-token' },
    "authProfiles.glm: user cannot be set on a github profile, whose hosts and headers the broker's github secret fixes",
  ],
  [{ dependencies: 'glm' }, 'authProfiles.glm: dependencies must be an array of profile names'],
])('it refuses a github profile with %p', (override, error) => {
  expect(
    collectAuthProfiles({ glm: { secret: 'github-agents', kind: 'github', ...override } }),
  ).toStrictEqual({ profiles: new Map(), errors: [error] });
});

test('it reads a profile whose secret and header names only a broker may refuse', () => {
  expect(
    collectAuthProfiles({
      glm: { secret: 'GLM_Key', host: 'api.z.ai', header: 'Authorization', scheme: 'bearer' },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'glm',
        {
          name: 'glm',
          secret: 'GLM_Key',
          kind: 'custom',
          host: 'api.z.ai',
          header: 'Authorization',
          scheme: 'bearer',
          env: {},
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
  [
    { kind: 'anthropic' },
    'authProfiles.glm: kind must be custom, oauth, or github, the kinds atc binds',
  ],
  [{ scheme: 'basic' }, 'authProfiles.glm: scheme must be bearer or raw, the schemes atc binds'],
  [
    { user: 'me' },
    'authProfiles.glm: user pairs only with the basic scheme, which atc does not bind',
  ],
  [{ secret: '' }, 'authProfiles.glm: secret must be the name of a broker secret'],
  [{ secret: 7 }, 'authProfiles.glm: secret must be the name of a broker secret'],
  [
    { host: 'API.z.ai' },
    'authProfiles.glm: host must be a lowercase hostname such as api.example.com',
  ],
  [
    { host: '*.z.ai' },
    'authProfiles.glm: host must be a lowercase hostname such as api.example.com',
  ],
  [
    { host: '10.0.0.1' },
    'authProfiles.glm: host must be a lowercase hostname such as api.example.com',
  ],
  [
    { host: 'api.z.ai:443' },
    'authProfiles.glm: host must be a lowercase hostname such as api.example.com',
  ],
  [{ header: '' }, 'authProfiles.glm: header must be a header name such as authorization'],
  [{ dependencies: 'judge' }, 'authProfiles.glm: dependencies must be an array of profile names'],
  [
    { dependencies: ['judge', 3] },
    'authProfiles.glm: dependencies must be an array of profile names',
  ],
])('it refuses a profile with %p', (override, error) => {
  expect(
    collectAuthProfiles({
      glm: {
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

test('it keeps the variables of a custom profile set to the placeholder or its own host', () => {
  expect(
    collectAuthProfiles({
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
        env: {
          OP_CONNECT_HOST: 'https://op-connect.example.com',
          OP_CONNECT_TOKEN: 'broker-placeholder',
        },
      },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: {
            OP_CONNECT_HOST: 'https://op-connect.example.com',
            OP_CONNECT_TOKEN: 'broker-placeholder',
          },
          dependencies: [],
        },
      ],
    ]),
    errors: [],
  });
});

test('it gives a profile that sets no variables an empty env', () => {
  expect(
    collectAuthProfiles({
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    }),
  ).toStrictEqual({
    profiles: new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.example.com',
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

test.each([
  [
    { X_URL: 'https://other.example.com' },
    'env.X_URL must be broker-placeholder or https://op-connect.example.com',
  ],
  [
    { X_URL: 'https://op-connect.example.com/v1' },
    'env.X_URL must be broker-placeholder or https://op-connect.example.com',
  ],
  [
    { X_URL: 'https://op-connect.example.com:8443' },
    'env.X_URL must be broker-placeholder or https://op-connect.example.com',
  ],
  [
    { X_URL: 'http://op-connect.example.com' },
    'env.X_URL must be broker-placeholder or https://op-connect.example.com',
  ],
  [
    { X_TOKEN: 'a-real-looking-token' },
    'env.X_TOKEN must be broker-placeholder or https://op-connect.example.com',
  ],
  [{ X_TOKEN: 7 }, 'env.X_TOKEN must be broker-placeholder or https://op-connect.example.com'],
  [
    { lower: 'broker-placeholder' },
    'env.lower is not a variable name: use capital letters, digits and underscores',
  ],
  [
    { '1X': 'broker-placeholder' },
    'env.1X is not a variable name: use capital letters, digits and underscores',
  ],
  ['x', 'env must be an object of variable names'],
])('it refuses a profile whose env is %p', (env, error) => {
  expect(
    collectAuthProfiles({
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
        env,
      },
    }),
  ).toStrictEqual({
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
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PATH',
  'HOME',
])('it refuses a profile that sets the reserved variable %s', (name) => {
  expect(
    collectAuthProfiles({
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
        env: { [name]: 'broker-placeholder' },
      },
    }),
  ).toStrictEqual({
    profiles: new Map(),
    errors: [`authProfiles.op: env.${name} cannot be set: atc or the broker sets or reserves it`],
  });
});

test('it refuses env on a github profile', () => {
  expect(
    collectAuthProfiles({
      glm: { secret: 'github-agents', kind: 'github', env: { GH_TOKEN: 'broker-placeholder' } },
    }),
  ).toStrictEqual({
    profiles: new Map(),
    errors: [
      "authProfiles.glm: env cannot be set on a github profile, whose placeholders the broker's github secret sets",
    ],
  });
});
