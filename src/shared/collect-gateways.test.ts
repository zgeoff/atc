import { expect, test } from 'bun:test';
import { collectGateways } from './collect-gateways';

test('it reads an entry into a gateway that names its own binary and menu row', () => {
  expect(
    collectGateways(
      {
        zai: {
          label: 'GLM (z.ai)',
          mark: 'z',
          baseURL: 'https://api.z.ai/api/anthropic',
          apiKeyHelper: '~/.local/bin/atc-zai-key',
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
      },
      'claude',
      ['--verbose'],
    ).gateways,
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: 'claude',
      args: ['--verbose'],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '~/.local/bin/atc-zai-key',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
    },
  ]);
});

test('it falls back to the id for a label and a mark that were not given', () => {
  expect(
    collectGateways({ kimi: { baseURL: 'https://api.moonshot.ai/anthropic' } }, 'claude', [])
      .gateways,
  ).toStrictEqual([
    {
      id: 'kimi',
      label: 'kimi',
      mark: 'k',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.moonshot.ai/anthropic',
      env: {},
    },
  ]);
});

test('it takes one character of a longer mark, so the overlay column stays one wide', () => {
  expect(
    collectGateways(
      { zai: { mark: 'zai', baseURL: 'https://api.z.ai/api/anthropic' } },
      'claude',
      [],
    ).gateways,
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});

test('it keeps a gateway that names its own binary instead of the Claude one', () => {
  expect(
    collectGateways(
      {
        zai: {
          bin: '/opt/claude-beta',
          args: ['--foo'],
          baseURL: 'https://api.z.ai/api/anthropic',
        },
      },
      'claude',
      ['--verbose'],
    ).gateways,
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: '/opt/claude-beta',
      args: ['--foo'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});

test('it drops an environment value that is not a string, since a child takes strings', () => {
  expect(
    collectGateways(
      {
        zai: {
          baseURL: 'https://api.z.ai/api/anthropic',
          env: { API_TIMEOUT_MS: 3_000_000, ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
      },
      'claude',
      [],
    ).gateways,
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
    },
  ]);
});

test('it leaves out an entry with no base URL, which could not be spawned', () => {
  expect(collectGateways({ zai: { label: 'GLM (z.ai)' } }, 'claude', []).gateways).toStrictEqual(
    [],
  );
});

test('it leaves out an entry under an id a built-in agent already answers to', () => {
  expect(
    collectGateways(
      {
        claude: { baseURL: 'https://example.test/anthropic' },
        grok: { baseURL: 'https://example.test/anthropic' },
        codex: { baseURL: 'https://example.test/anthropic' },
      },
      'claude',
      [],
    ).gateways,
  ).toStrictEqual([]);
});

test.each([[undefined], [null], ['zai'], [42], [[]]])(
  'it reads %p as no gateways at all',
  (raw) => {
    expect(collectGateways(raw, 'claude', []).gateways).toStrictEqual([]);
  },
);

test.each([
  [null],
  ['https://api.z.ai/api/anthropic'],
  [42],
  [[]],
  [{}],
  [{ baseURL: 42 }],
  [{ baseURL: '' }],
])('it leaves out %p as a malformed gateway entry', (entry) => {
  expect(collectGateways({ zai: entry }, 'claude', []).gateways).toStrictEqual([]);
});

test('it falls back to every default when an entry has a valid base URL but every other field is wrong-typed', () => {
  expect(
    collectGateways(
      {
        zai: {
          baseURL: 'https://api.z.ai/api/anthropic',
          label: 7,
          mark: 7,
          bin: 42,
          args: 'not-an-array',
          apiKeyHelper: 42,
          env: 'nope',
        },
      },
      'claude',
      ['--verbose'],
    ).gateways,
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: ['--verbose'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});

// The hook that judges a gateway session's tool calls is registered here, so
// the block reaches the generated settings file whole.
test('it carries a settings block through to the gateway', () => {
  const settings = {
    hooks: {
      PermissionRequest: [
        { matcher: '.*', hooks: [{ type: 'command', command: 'classify-tool-call' }] },
      ],
    },
  };

  const [gateway] = collectGateways(
    { zai: { baseURL: 'https://api.z.ai/api/anthropic', settings } },
    'claude',
    [],
  ).gateways;

  expect(gateway?.settings).toStrictEqual(settings);
});

test('it leaves out a settings value that is not an object', () => {
  const [gateway] = collectGateways(
    { zai: { baseURL: 'https://api.z.ai/api/anthropic', settings: 'on' } },
    'claude',
    [],
  ).gateways;

  expect(gateway?.settings).toBeUndefined();
});

test('it keeps a gateway whose auth selects profiles that cover its base URL host', () => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: {
            profiles: ['glm'],
            placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          },
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
        },
      },
      'claude',
      [],
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
      ]),
    ),
  ).toStrictEqual({
    gateways: [
      {
        id: 'glm',
        label: 'glm',
        mark: 'g',
        bin: 'claude',
        args: [],
        baseURL: 'https://api.z.ai/api/anthropic',
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    ],
    errors: [],
  });
});

test('it keeps a gateway whose auth selects a github profile beside the profile for its base URL host', () => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: {
            profiles: ['glm', 'github'],
            placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          },
        },
      },
      'claude',
      [],
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
    ),
  ).toStrictEqual({
    gateways: [
      {
        id: 'glm',
        label: 'glm',
        mark: 'g',
        bin: 'claude',
        args: [],
        baseURL: 'https://api.z.ai/api/anthropic',
        env: {},
        auth: {
          profiles: ['glm', 'github'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    ],
    errors: [],
  });
});

test('it keeps a proxy variable in the env of a gateway without auth', () => {
  expect(
    collectGateways(
      {
        zai: {
          baseURL: 'https://api.z.ai/api/anthropic',
          env: { HTTPS_PROXY: 'http://proxy:3128' },
        },
      },
      'claude',
      [],
    ),
  ).toStrictEqual({
    gateways: [
      {
        id: 'zai',
        label: 'zai',
        mark: 'z',
        bin: 'claude',
        args: [],
        baseURL: 'https://api.z.ai/api/anthropic',
        env: { HTTPS_PROXY: 'http://proxy:3128' },
      },
    ],
    errors: [],
  });
});

test.each([
  [
    { apiKeyHelper: '~/.local/bin/glm-key' },
    'gateways.glm: apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
  ],
  [
    { baseURL: 'http://api.z.ai/api/anthropic' },
    'gateways.glm: baseURL must be an https URL with no port or user info',
  ],
  [
    { baseURL: 'https://api.z.ai:8443/' },
    'gateways.glm: baseURL must be an https URL with no port or user info',
  ],
  [
    { baseURL: 'not a url' },
    'gateways.glm: baseURL must be an https URL with no port or user info',
  ],
  [
    { baseURL: 'https://other.example.com/anthropic' },
    'gateways.glm: baseURL host other.example.com is not a host of the selected profiles (api.z.ai)',
  ],
  [{ env: { HTTPS_PROXY: 'http://proxy:3128' } }, 'gateways.glm: env must not set HTTPS_PROXY'],
  [{ env: { https_proxy: 'http://proxy:3128' } }, 'gateways.glm: env must not set https_proxy'],
  [{ env: { NO_PROXY: 'api.z.ai' } }, 'gateways.glm: env must not set NO_PROXY'],
  [{ env: { NODE_USE_ENV_PROXY: '1' } }, 'gateways.glm: env must not set NODE_USE_ENV_PROXY'],
  [{ env: { SSL_CERT_FILE: '/tmp/ca.pem' } }, 'gateways.glm: env must not set SSL_CERT_FILE'],
  [
    { env: { NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' } },
    'gateways.glm: env must not set NODE_EXTRA_CA_CERTS',
  ],
  [{ env: { GIT_SSL_CAINFO: '/tmp/ca.pem' } }, 'gateways.glm: env must not set GIT_SSL_CAINFO'],
  [
    { env: { REQUESTS_CA_BUNDLE: '/tmp/ca.pem' } },
    'gateways.glm: env must not set REQUESTS_CA_BUNDLE',
  ],
  [{ env: { CURL_CA_BUNDLE: '/tmp/ca.pem' } }, 'gateways.glm: env must not set CURL_CA_BUNDLE'],
  [
    { settings: { env: { SSL_CERT_FILE: '/tmp/ca.pem' } } },
    'gateways.glm: settings.env must not set SSL_CERT_FILE',
  ],
  [
    { auth: { profiles: ['glm'], placeholderEnv: {} }, env: { ANTHROPIC_AUTH_TOKEN: 'sk-real' } },
    'gateways.glm: env must not set ANTHROPIC_AUTH_TOKEN',
  ],
  [{ env: { ANTHROPIC_API_KEY: 'sk-real' } }, 'gateways.glm: env must not set ANTHROPIC_API_KEY'],
  [
    { env: { ANTHROPIC_BASE_URL: 'https://other.example.com' } },
    'gateways.glm: env must not set ANTHROPIC_BASE_URL',
  ],
  [
    { settings: { env: { ANTHROPIC_API_KEY: 'sk-real' } } },
    'gateways.glm: settings.env must not set ANTHROPIC_API_KEY',
  ],
  [
    { settings: { apiKeyHelper: '~/.local/bin/glm-key' } },
    'gateways.glm: settings.apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
  ],
])('it refuses a gateway with auth and %p', (override, error) => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: {
            profiles: ['glm'],
            placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          },
          ...override,
        },
      },
      'claude',
      [],
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
      ]),
    ),
  ).toStrictEqual({ gateways: [], errors: [error] });
});

test.each([
  [null, 'gateways.glm: auth must be an object with a non-empty profiles array'],
  [{ profiles: [] }, 'gateways.glm: auth must be an object with a non-empty profiles array'],
  [
    { profiles: ['glm', 3] },
    'gateways.glm: auth must be an object with a non-empty profiles array',
  ],
  [
    { profiles: ['glm'], placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'sk-real' } },
    'gateways.glm: placeholderEnv.ANTHROPIC_AUTH_TOKEN must be imp-broker-placeholder',
  ],
  [
    { profiles: ['glm'], placeholderEnv: { HTTPS_PROXY: 'imp-broker-placeholder' } },
    'gateways.glm: placeholderEnv must not set HTTPS_PROXY',
  ],
  [
    { profiles: ['glm'], placeholderEnv: { ANTHROPIC_BASE_URL: 'imp-broker-placeholder' } },
    'gateways.glm: placeholderEnv must not set ANTHROPIC_BASE_URL',
  ],
  [
    { profiles: ['glm'], placeholderEnv: 'ANTHROPIC_AUTH_TOKEN' },
    'gateways.glm: placeholderEnv must be an object of variable names',
  ],
  [
    { profiles: ['judge'], placeholderEnv: {} },
    'gateways.glm: profile judge is selected, but authProfiles has no usable profile by that name',
  ],
])('it refuses a gateway whose auth is %p', (auth, error) => {
  expect(
    collectGateways(
      { glm: { baseURL: 'https://api.z.ai/api/anthropic', auth } },
      'claude',
      [],
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
      ]),
    ),
  ).toStrictEqual({ gateways: [], errors: [error] });
});

test('it refuses a placeholder variable that the gateway env also sets, since the env would win', () => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: { profiles: ['glm'], placeholderEnv: { GLM_TOKEN: 'imp-broker-placeholder' } },
          settings: { env: { GLM_TOKEN: 'sk-real' } },
        },
      },
      'claude',
      [],
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
      ]),
    ),
  ).toStrictEqual({
    gateways: [],
    errors: [
      'gateways.glm: placeholderEnv.GLM_TOKEN is also set in settings.env, which would override it',
    ],
  });
});

test('it refuses a gateway whose profiles reach an undeclared dependency', () => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: { profiles: ['glm'], placeholderEnv: {} },
        },
      },
      'claude',
      [],
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
    ),
  ).toStrictEqual({
    gateways: [],
    errors: [
      'gateways.glm: profile glm depends on judge, but authProfiles has no usable profile by that name',
    ],
  });
});

test('it refuses a gateway whose profiles collide on one host after their dependencies expand', () => {
  expect(
    collectGateways(
      {
        glm: {
          baseURL: 'https://api.z.ai/api/anthropic',
          auth: { profiles: ['glm'], placeholderEnv: {} },
        },
      },
      'claude',
      [],
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
    ),
  ).toStrictEqual({
    gateways: [],
    errors: ['gateways.glm: profiles glm and judge both send a credential to api.z.ai'],
  });
});
