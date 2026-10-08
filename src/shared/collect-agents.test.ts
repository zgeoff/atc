import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '../test-utils/build-mock-auth-profile';
import { collectAgents } from './collect-agents';
import type { AuthProfile } from './collect-auth-profiles';

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
  expect(collectAgents({ '🚀fast': { kind: 'codex' } })).toStrictEqual({
    agents: [
      { id: '🚀fast', kind: 'codex', label: '🚀fast', mark: '🚀', bin: 'codex', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it takes the first code point of a configured mark', () => {
  expect(collectAgents({ claude: { mark: '🚀ab' } })).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: '🚀',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: [],
  });
});

test('it keeps registry order and loads several entries of one kind', () => {
  const result = collectAgents({
    'claude-b': { kind: 'claude', args: ['--b'] },
    claude: { args: ['--a'] },
  });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-b',
        kind: 'claude',
        label: 'claude-b',
        mark: 'c',
        bin: 'claude',
        args: ['--b'],
        env: {},
      },
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: ['--a'],
        env: {},
      },
    ],
    errors: [],
  });
});

test('it loads a claude entry with settings and env as stock Claude', () => {
  const result = collectAgents({
    claude: { settings: { model: 'opus' }, env: { FOO: 'bar' } },
  });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: { FOO: 'bar' },
        settings: { model: 'opus' },
      },
    ],
    errors: [],
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

  expect(result).toStrictEqual({
    agents: [
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
    ],
    errors: [],
  });
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
    new Map<string, AuthProfile>([
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'glm',
        kind: 'claude',
        label: 'glm',
        mark: 'g',
        bin: 'claude',
        args: [],
        env: {},
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    ],
    errors: [],
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
    new Map<string, AuthProfile>([
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.glm: apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
    ],
  });
});

test('it loads a stock claude entry with subscription auth as profiles alone', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
        auth: { profiles: ['claude'], placeholderEnv: {} },
      },
    ],
    errors: [],
  });
});

test("it loads a stock claude entry's MCP servers with the header of each server's profile", () => {
  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude', 'linear'],
          mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
        },
      },
    },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'linear',
        buildMockAuthProfile({
          name: 'linear',
          host: 'mcp.linear.app',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
        auth: { profiles: ['claude', 'linear'], placeholderEnv: {} },
        mcpServers: [
          {
            name: 'linear',
            url: 'https://mcp.linear.app/mcp',
            profile: 'linear',
            header: 'authorization',
          },
        ],
      },
    ],
    errors: [],
  });
});

test('it loads a stock claude entry without an MCP server that breaks a rule, and reports the server', () => {
  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude', 'linear'],
          mcpServers: { linear: { url: 'https://api.linear.app/mcp', profile: 'linear' } },
        },
      },
    },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'linear',
        buildMockAuthProfile({
          name: 'linear',
          host: 'mcp.linear.app',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
        auth: { profiles: ['claude', 'linear'], placeholderEnv: {} },
      },
    ],
    errors: [
      'agents.claude: auth.mcpServers.linear: url must be on mcp.linear.app, the host profile linear sends its credential to',
    ],
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
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: auth.placeholderEnv cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
    ],
  });
});

test('it refuses a stock entry whose auth names a profile that sends no bearer header to Anthropic', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['glm'] } } },
    new Map<string, AuthProfile>([
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: auth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});

test('it loads a codex entry whose auth signs it in through an oauth profile for chatgpt.com', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['codex', 'github'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'codex',
        kind: 'codex',
        label: 'Codex',
        mark: 'c',
        bin: 'codex',
        args: [],
        env: {},
        auth: { profiles: ['codex', 'github'], placeholderEnv: {} },
      },
    ],
    errors: [],
  });
});

test('it refuses a codex entry whose auth has no oauth profile for chatgpt.com', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['github'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth needs an oauth profile that sets a bearer authorization header for chatgpt.com, where Codex sends its ChatGPT sign-in',
    ],
  });
});

test('it refuses a codex entry whose auth has a custom profile for chatgpt.com', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['codex-custom'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth needs an oauth profile that sets a bearer authorization header for chatgpt.com, where Codex sends its ChatGPT sign-in',
    ],
  });
});

test('it refuses a codex entry whose auth has an oauth profile with another header', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['codex-raw'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth needs an oauth profile that sets a bearer authorization header for chatgpt.com, where Codex sends its ChatGPT sign-in',
    ],
  });
});

test('it refuses a codex entry whose auth has two profiles for chatgpt.com', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['codex', 'codex-custom'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth: profiles codex and codex-custom both send a credential to chatgpt.com',
    ],
  });
});

test('it refuses a codex entry whose auth has an unknown profile', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['missing'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth: profile missing is selected, but authProfiles has no usable profile by that name',
    ],
  });
});

test('it refuses a codex entry whose auth has an empty profiles array', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: [] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.codex: auth must be an object with a non-empty profiles array'],
  });
});

test('it refuses a codex entry whose auth has placeholderEnv', () => {
  const result = collectAgents(
    { codex: { auth: { profiles: ['codex'], placeholderEnv: {} } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth.placeholderEnv cannot be set: atc fixes the endpoint and the sign-in of a Codex session',
    ],
  });
});

test('it refuses auth on a grok entry', () => {
  const result = collectAgents(
    { grok: { auth: { profiles: ['codex'] } } },
    new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.grok: auth is not valid for kind grok'],
  });
});

test('it refuses apiKeyHelper on an entry without a baseURL', () => {
  expect(collectAgents({ claude: { apiKeyHelper: 'op read x' } })).toStrictEqual({
    agents: [],
    errors: ['agents.claude: apiKeyHelper is only valid together with baseURL'],
  });
});

test('it refuses an entry with an unknown field and reports it alone', () => {
  const result = collectAgents({ claude: { colour: 'red' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: unknown field colour'],
  });
});

test('it refuses an entry with a wrong-typed args and reports it alone', () => {
  const result = collectAgents({ claude: { args: 'x' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: args must be an array of strings'],
  });
});

test('it refuses an entry with an empty bin and reports it alone', () => {
  const result = collectAgents({ claude: { bin: '' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: bin must be a non-empty string'],
  });
});

test('it refuses an entry with a non-string env value and reports it alone', () => {
  const result = collectAgents({ claude: { env: { A: 1 } }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: env must be an object of strings'],
  });
});

test('it refuses an entry with an array for settings and reports it alone', () => {
  const result = collectAgents({
    claude: { settings: ['model'] },
    'claude-ok': { kind: 'claude' },
  });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: settings must be an object'],
  });
});

test('it refuses an entry with a baseURL on codex and reports it alone', () => {
  const result = collectAgents({
    codex: { baseURL: 'https://x.example.com' },
    'claude-ok': { kind: 'claude' },
  });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.codex: baseURL is not valid for kind codex'],
  });
});

test('it refuses an entry with env on grok and reports it alone', () => {
  const result = collectAgents({ grok: { env: { A: 'b' } }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.grok: env is not valid for kind grok'],
  });
});

test('it refuses an entry with a kind that contradicts its id and reports it alone', () => {
  const result = collectAgents({ codex: { kind: 'claude' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.codex: kind claude contradicts the id codex'],
  });
});

test('it refuses an entry with no kind on a custom id and reports it alone', () => {
  const result = collectAgents({ fast: {}, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.fast: kind is required for an id other than claude, codex, or grok'],
  });
});

test('it refuses an entry with an unknown kind and reports it alone', () => {
  const result = collectAgents({ fast: { kind: 'vim' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.fast: kind must be claude, codex, or grok'],
  });
});

test('it refuses an entry with a non-object entry and reports it alone', () => {
  const result = collectAgents({ claude: 7, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: the entry must be an object'],
  });
});

test('it refuses an entry with an empty id and reports it alone', () => {
  const result = collectAgents({ '': { kind: 'claude' }, 'claude-ok': { kind: 'claude' } });

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.: the id cannot be used'],
  });
});

test('it refuses the __proto__ id', () => {
  const raw: unknown = JSON.parse('{ "__proto__": { "kind": "claude" } }');

  expect(collectAgents(raw)).toStrictEqual({
    agents: [],
    errors: ['agents.__proto__: the id cannot be used'],
  });
});

test('it leaves an empty registry and one error when agents is an array', () => {
  expect(collectAgents([])).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test('it leaves an empty registry and one error when agents is a string', () => {
  expect(collectAgents('claude')).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test('it leaves an empty registry and one error when agents is null', () => {
  expect(collectAgents(null)).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test('it refuses a stock entry with auth whose env.ANTHROPIC_BASE_URL would route around the subscription sign-in', () => {
  const result = collectAgents(
    {
      claude: {
        auth: { profiles: ['claude'] },
        env: { ANTHROPIC_BASE_URL: 'https://x.example.com' },
      },
    },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: env must not set ANTHROPIC_BASE_URL, which would override or route around the subscription sign-in',
    ],
  });
});

test('it refuses a stock entry with auth whose env.HTTPS_PROXY would route around the subscription sign-in', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] }, env: { HTTPS_PROXY: 'http://p.example:3128' } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: env must not set HTTPS_PROXY, which would override or route around the subscription sign-in',
    ],
  });
});

test('it refuses a stock entry with auth whose env.CLAUDE_CODE_OAUTH_TOKEN would route around the subscription sign-in', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] }, env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: env must not set CLAUDE_CODE_OAUTH_TOKEN, which would override or route around the subscription sign-in',
    ],
  });
});

test('it refuses a stock entry with auth whose settings.env.CLAUDE_CODE_USE_BEDROCK would route around the subscription sign-in', () => {
  const result = collectAgents(
    {
      claude: {
        auth: { profiles: ['claude'] },
        settings: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
      },
    },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: settings.env must not set CLAUDE_CODE_USE_BEDROCK, which would override or route around the subscription sign-in',
    ],
  });
});

test('it refuses a stock entry with auth whose settings.env.SSL_CERT_FILE would route around the subscription sign-in', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] }, settings: { env: { SSL_CERT_FILE: '/x' } } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: settings.env must not set SSL_CERT_FILE, which would override or route around the subscription sign-in',
    ],
  });
});

test('it refuses a stock entry with auth whose settings set apiKeyHelper', () => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude'] }, settings: { apiKeyHelper: 'op read x' } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
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

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: { ANTHROPIC_BASE_URL: 'https://x.example.com', HTTPS_PROXY: 'http://p.example:3128' },
        settings: { apiKeyHelper: 'op read x', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
      },
    ],
    errors: [],
  });
});

test('it refuses a stock claude entry whose env sets a variable its profile sets', () => {
  const result = collectAgents(
    { claude: { env: { OP_CONNECT_TOKEN: 'x' }, auth: { profiles: ['claude', 'op'] } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'op',
        buildMockAuthProfile({
          name: 'op',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.claude: env sets OP_CONNECT_TOKEN, which auth profile op sets'],
  });
});

test('it refuses a stock claude entry whose settings.env sets a variable its profile sets', () => {
  const result = collectAgents(
    {
      claude: {
        settings: { env: { OP_CONNECT_TOKEN: 'x' } },
        auth: { profiles: ['claude', 'op'] },
      },
    },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'op',
        buildMockAuthProfile({
          name: 'op',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.claude: settings.env sets OP_CONNECT_TOKEN, which auth profile op sets'],
  });
});

test('it refuses a gateway whose env sets a variable its profile sets', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        env: { OP_CONNECT_TOKEN: 'x' },
        auth: { profiles: ['glm', 'op'] },
      },
    },
    new Map<string, AuthProfile>([
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'op',
        buildMockAuthProfile({
          name: 'op',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.glm: env sets OP_CONNECT_TOKEN, which auth profile op sets'],
  });
});

test('it refuses a gateway whose settings.env sets a variable its profile sets', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        settings: { env: { OP_CONNECT_TOKEN: 'x' } },
        auth: { profiles: ['glm', 'op'] },
      },
    },
    new Map<string, AuthProfile>([
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'op',
        buildMockAuthProfile({
          name: 'op',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.glm: settings.env sets OP_CONNECT_TOKEN, which auth profile op sets'],
  });
});

test('it allows an entry to set a variable that none of its selected profiles set', () => {
  const result = collectAgents(
    { claude: { env: { OP_CONNECT_TOKEN: 'x' }, auth: { profiles: ['claude'] } } },
    new Map<string, AuthProfile>([
      [
        'claude',
        buildMockAuthProfile({
          name: 'claude',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
      [
        'op',
        buildMockAuthProfile({
          name: 'op',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
        }),
      ],
    ]),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: { OP_CONNECT_TOKEN: 'x' },
        auth: { profiles: ['claude'], placeholderEnv: {} },
      },
    ],
    errors: [],
  });
});
