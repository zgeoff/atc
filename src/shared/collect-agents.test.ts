import { expect, test } from 'bun:test';
import { collectAgents } from './collect-agents';
import { collectAuthProfiles } from './collect-auth-profiles';

const PROFILES = collectAuthProfiles({
  claude: {
    secret: 'claude-setup-token',
    host: 'api.anthropic.com',
    header: 'authorization',
    scheme: 'bearer',
  },
  glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
}).profiles;

test('it fills every default for the three ids that name a kind', () => {
  expect(collectAgents({ claude: {}, codex: {}, grok: {} })).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it defaults a custom id to its own label and first character', () => {
  const result = collectAgents({ '🚀fast': { kind: 'codex' } });

  expect(result.agents).toStrictEqual([
    { id: '🚀fast', kind: 'codex', label: '🚀fast', mark: '🚀', bin: 'codex', args: [], env: {} },
  ]);
});

test('it takes the first code point of a configured mark', () => {
  const result = collectAgents({ claude: { mark: '🚀ab' } });

  expect(result.agents[0]?.mark).toBe('🚀');
});

test('it keeps registry order and loads several entries of one kind', () => {
  const result = collectAgents({
    'claude-b': { kind: 'claude', args: ['--b'] },
    claude: { args: ['--a'] },
  });

  expect(result.agents.map((entry) => [entry.id, entry.args])).toStrictEqual([
    ['claude-b', ['--b']],
    ['claude', ['--a']],
  ]);
});

test('it loads a claude entry with settings and env as stock Claude', () => {
  const result = collectAgents({
    claude: { settings: { model: 'opus' }, env: { FOO: 'bar' } },
  });

  expect({ errors: result.errors, agent: result.agents[0] }).toStrictEqual({
    errors: [],
    agent: {
      id: 'claude',
      kind: 'claude',
      label: 'Claude',
      mark: 'c',
      bin: 'claude',
      args: [],
      env: { FOO: 'bar' },
      settings: { model: 'opus' },
    },
  });
});

test('it loads a claude entry with a baseURL as a gateway', () => {
  const result = collectAgents({
    zai: {
      kind: 'claude',
      label: 'GLM',
      mark: 'z',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'op read x',
    },
  });

  expect(result.agents).toStrictEqual([
    {
      id: 'zai',
      kind: 'claude',
      label: 'GLM',
      mark: 'z',
      bin: 'claude',
      args: [],
      env: {},
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'op read x',
    },
  ]);
});

test('it loads a gateway with auth through the gateway checks', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    },
    PROFILES,
  );

  expect({ errors: result.errors, auth: result.agents[0]?.auth }).toStrictEqual({
    errors: [],
    auth: {
      profiles: ['glm'],
      placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
    },
  });
});

test('it refuses a gateway whose apiKeyHelper is set beside auth', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read x',
        auth: { profiles: ['glm'] },
      },
    },
    PROFILES,
  );

  expect({ agents: result.agents, errors: result.errors }).toStrictEqual({
    agents: [],
    errors: [
      'agents.glm: apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
    ],
  });
});

test('it loads a stock claude entry with subscription auth as profiles alone', () => {
  const result = collectAgents({ claude: { auth: { profiles: ['claude'] } } }, PROFILES);

  expect({ errors: result.errors, auth: result.agents[0]?.auth }).toStrictEqual({
    errors: [],
    auth: { profiles: ['claude'], placeholderEnv: {} },
  });
});

test("it loads a stock claude entry's MCP servers with the header of each server's profile", () => {
  const profiles = collectAuthProfiles({
    claude: {
      secret: 'claude-setup-token',
      host: 'api.anthropic.com',
      header: 'authorization',
      scheme: 'bearer',
    },
    linear: {
      secret: 'linear-imp-agents',
      host: 'mcp.linear.app',
      header: 'authorization',
      scheme: 'bearer',
    },
  }).profiles;

  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude', 'linear'],
          mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
        },
      },
    },
    profiles,
  );

  expect({ errors: result.errors, mcpServers: result.agents[0]?.mcpServers }).toStrictEqual({
    errors: [],
    mcpServers: [
      {
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        profile: 'linear',
        header: 'authorization',
      },
    ],
  });
});

test('it loads a stock claude entry without an MCP server that breaks a rule, and reports the server', () => {
  const profiles = collectAuthProfiles({
    claude: {
      secret: 'claude-setup-token',
      host: 'api.anthropic.com',
      header: 'authorization',
      scheme: 'bearer',
    },
    linear: {
      secret: 'linear-imp-agents',
      host: 'mcp.linear.app',
      header: 'authorization',
      scheme: 'bearer',
    },
  }).profiles;

  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude', 'linear'],
          mcpServers: { linear: { url: 'https://api.linear.app/mcp', profile: 'linear' } },
        },
      },
    },
    profiles,
  );

  expect({
    errors: result.errors,
    auth: result.agents[0]?.auth,
    mcpServers: result.agents[0]?.mcpServers,
  }).toStrictEqual({
    errors: [
      'agents.claude: auth.mcpServers.linear: url must be on mcp.linear.app, the host profile linear sends its credential to',
    ],
    auth: { profiles: ['claude', 'linear'], placeholderEnv: {} },
    mcpServers: undefined,
  });
});

test('it refuses a stock entry whose auth sets placeholderEnv', () => {
  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    },
    PROFILES,
  );

  expect({ agents: result.agents, errors: result.errors }).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: auth.placeholderEnv cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
    ],
  });
});

test('it refuses a stock entry whose auth names a profile that sends no bearer header to Anthropic', () => {
  const result = collectAgents({ claude: { auth: { profiles: ['glm'] } } }, PROFILES);

  expect(result.errors).toStrictEqual([
    'agents.claude: auth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
  ]);
});

test('it refuses apiKeyHelper on an entry without a baseURL', () => {
  const result = collectAgents({ claude: { apiKeyHelper: 'op read x' } });

  expect({ agents: result.agents, errors: result.errors }).toStrictEqual({
    agents: [],
    errors: ['agents.claude: apiKeyHelper is only valid together with baseURL'],
  });
});

test.each([
  ['an unknown field', { claude: { colour: 'red' } }, 'agents.claude: unknown field colour'],
  [
    'a wrong-typed args',
    { claude: { args: 'x' } },
    'agents.claude: args must be an array of strings',
  ],
  ['an empty bin', { claude: { bin: '' } }, 'agents.claude: bin must be a non-empty string'],
  [
    'a non-string env value',
    { claude: { env: { A: 1 } } },
    'agents.claude: env must be an object of strings',
  ],
  [
    'a baseURL on codex',
    { codex: { baseURL: 'https://x.example.com' } },
    'agents.codex: baseURL is not valid for kind codex',
  ],
  ['env on grok', { grok: { env: { A: 'b' } } }, 'agents.grok: env is not valid for kind grok'],
  [
    'a kind that contradicts its id',
    { codex: { kind: 'claude' } },
    'agents.codex: kind claude contradicts the id codex',
  ],
  [
    'no kind on a custom id',
    { fast: {} },
    'agents.fast: kind is required for an id other than claude, codex, or grok',
  ],
  [
    'an unknown kind',
    { fast: { kind: 'vim' } },
    'agents.fast: kind must be claude, codex, or grok',
  ],
  ['a non-object entry', { claude: 7 }, 'agents.claude: the entry must be an object'],
  ['an empty id', { '': { kind: 'claude' } }, 'agents.: the id cannot be used'],
])('it refuses an entry with %s and reports it alone', (_name, raw, error) => {
  const result = collectAgents({ ...raw, 'claude-ok': { kind: 'claude' } });

  expect({ ids: result.agents.map((entry) => entry.id), errors: result.errors }).toStrictEqual({
    ids: ['claude-ok'],
    errors: [error],
  });
});

test('it refuses the __proto__ id', () => {
  const raw: unknown = JSON.parse('{ "__proto__": { "kind": "claude" } }');

  expect(collectAgents(raw)).toStrictEqual({
    agents: [],
    errors: ['agents.__proto__: the id cannot be used'],
  });
});

test.each([
  ['an array', []],
  ['a string', 'claude'],
  ['null', null],
])('it leaves an empty registry and one error when agents is %s', (_name, raw) => {
  expect(collectAgents(raw)).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test.each([
  [
    'env.ANTHROPIC_BASE_URL',
    { env: { ANTHROPIC_BASE_URL: 'https://x.example.com' } },
    'env',
    'ANTHROPIC_BASE_URL',
  ],
  ['env.HTTPS_PROXY', { env: { HTTPS_PROXY: 'http://p.example:3128' } }, 'env', 'HTTPS_PROXY'],
  [
    'env.CLAUDE_CODE_OAUTH_TOKEN',
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } },
    'env',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ],
  [
    'settings.env.CLAUDE_CODE_USE_BEDROCK',
    { settings: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } },
    'settings.env',
    'CLAUDE_CODE_USE_BEDROCK',
  ],
  [
    'settings.env.SSL_CERT_FILE',
    { settings: { env: { SSL_CERT_FILE: '/x' } } },
    'settings.env',
    'SSL_CERT_FILE',
  ],
])(
  'it refuses a stock entry with auth whose %s would route around the subscription sign-in',
  (_name, fields, source, variable) => {
    const result = collectAgents(
      { claude: { auth: { profiles: ['claude'] }, ...fields } },
      PROFILES,
    );

    expect(result).toStrictEqual({
      agents: [],
      errors: [
        `agents.claude: ${source} must not set ${variable}, which would override or route around the subscription sign-in`,
      ],
    });
  },
);

test('it refuses a stock entry with auth whose settings set apiKeyHelper', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] }, settings: { apiKeyHelper: 'op read x' } } },
    PROFILES,
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: settings.apiKeyHelper must not be set, which would override the subscription sign-in',
    ],
  });
});

test('it loads the same env and settings on a stock entry without auth', () => {
  const result = collectAgents({
    claude: {
      env: { ANTHROPIC_BASE_URL: 'https://x.example.com', HTTPS_PROXY: 'http://p.example:3128' },
      settings: { apiKeyHelper: 'op read x', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
    },
  });

  expect({ ids: result.agents.map((entry) => entry.id), errors: result.errors }).toStrictEqual({
    ids: ['claude'],
    errors: [],
  });
});

const ENV_PROFILES = collectAuthProfiles({
  claude: {
    secret: 'claude-setup-token',
    host: 'api.anthropic.com',
    header: 'authorization',
    scheme: 'bearer',
  },
  glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  op: {
    secret: 'op-connect',
    host: 'op-connect.geoff.cloud',
    header: 'authorization',
    scheme: 'bearer',
    env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
  },
}).profiles;

test.each([
  ['env', { env: { OP_CONNECT_TOKEN: 'x' } }],
  ['settings.env', { settings: { env: { OP_CONNECT_TOKEN: 'x' } } }],
])('it refuses a stock claude entry whose %s sets a variable its profile sets', (source, extra) => {
  const result = collectAgents(
    { claude: { ...extra, auth: { profiles: ['claude', 'op'] } } },
    ENV_PROFILES,
  );

  expect({ agents: result.agents, errors: result.errors }).toStrictEqual({
    agents: [],
    errors: [`agents.claude: ${source} sets OP_CONNECT_TOKEN, which auth profile op sets`],
  });
});

test.each([
  ['env', { env: { OP_CONNECT_TOKEN: 'x' } }],
  ['settings.env', { settings: { env: { OP_CONNECT_TOKEN: 'x' } } }],
])('it refuses a gateway whose %s sets a variable its profile sets', (source, extra) => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        ...extra,
        auth: { profiles: ['glm', 'op'] },
      },
    },
    ENV_PROFILES,
  );

  expect({ agents: result.agents, errors: result.errors }).toStrictEqual({
    agents: [],
    errors: [`agents.glm: ${source} sets OP_CONNECT_TOKEN, which auth profile op sets`],
  });
});

test('it allows an entry to set a variable that none of its selected profiles set', () => {
  const result = collectAgents(
    { claude: { env: { OP_CONNECT_TOKEN: 'x' }, auth: { profiles: ['claude'] } } },
    ENV_PROFILES,
  );

  expect(result.errors).toStrictEqual([]);
});
