import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config/collect-agents';
import { parseConfig } from '@atc/config/config';
import type { AuthProfile } from '@atc/plugin-api/auth-profile';
import { buildMockAuthProfile } from '@atc/test-utils/build-mock-auth-profile';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import { buildClaudePlugin } from './build-claude-plugin';
import { ClaudeAdapter } from './claude-adapter';
import { GatewayAdapter } from './gateway/gateway-adapter';

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
    [buildClaudePlugin()],
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

test('it loads a gateway that holds a credential helper beside auth, with the arguments of its brokered launch', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        args: ['--plugin-dir', '/home/me/mods/auto-mode'],
        apiKeyHelper: 'op read x',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
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
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'glm',
        kind: 'claude',
        label: 'glm',
        mark: 'g',
        bin: 'claude',
        args: ['--plugin-dir', '/home/me/mods/auto-mode'],
        env: {},
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read x',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
        },
      },
    ],
    errors: [],
  });
});

test('it refuses a gateway whose auth args are not an array of strings', () => {
  const result = collectAgents(
    {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          args: ['--plugin-dir', 42],
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
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.glm: auth.args must be an array of strings'],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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

test("it loads a stock claude entry whose placeholder stands in for a non-Anthropic profile's key", () => {
  const result = collectAgents(
    {
      claude: {
        auth: {
          profiles: ['claude', 'jev'],
          placeholderEnv: { TYPESAFE_API_KEY: { profile: 'jev' } },
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
        'jev',
        buildMockAuthProfile({
          name: 'jev',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    [buildClaudePlugin()],
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
        auth: {
          profiles: ['claude', 'jev'],
          placeholderEnv: { TYPESAFE_API_KEY: 'imp-broker-placeholder' },
        },
      },
    ],
    errors: [],
  });
});

test.each([
  [
    'an Anthropic key',
    { ANTHROPIC_AUTH_TOKEN: { profile: 'jev' } },
    'agents.claude: auth.placeholderEnv.ANTHROPIC_AUTH_TOKEN: atc fixes the endpoint, the placeholder, and the launch variables of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, Codex, OpenAI, atc, launch, proxy or CA variable',
  ],
  [
    'a key on no profile',
    { TYPESAFE_API_KEY: 'imp-broker-placeholder' },
    'agents.claude: auth.placeholderEnv.TYPESAFE_API_KEY: a placeholder must be an object with the profile whose credential it stands in for',
  ],
  [
    'a key on the Anthropic profile',
    { TYPESAFE_API_KEY: { profile: 'claude' } },
    'agents.claude: auth.placeholderEnv.TYPESAFE_API_KEY: profile claude sends its credential to api.anthropic.com, and atc fixes the placeholder of a credential sent to Anthropic',
  ],
])('it refuses a stock entry whose placeholder is for %s', (_label, placeholderEnv, error) => {
  const result = collectAgents(
    { claude: { auth: { profiles: ['claude', 'jev'], placeholderEnv } } },
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
        'jev',
        buildMockAuthProfile({
          name: 'jev',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({ agents: [], errors: [error] });
});

test.each([
  ['env', { env: { TYPESAFE_API_KEY: 'sk-typesafe' } }],
  ['settings.env', { settings: { env: { TYPESAFE_API_KEY: 'sk-typesafe' } } }],
])('it refuses a stock entry whose %s also sets a placeholder', (source, overrides) => {
  const result = collectAgents(
    {
      claude: {
        ...overrides,
        auth: {
          profiles: ['claude', 'jev'],
          placeholderEnv: { TYPESAFE_API_KEY: { profile: 'jev' } },
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
        'jev',
        buildMockAuthProfile({
          name: 'jev',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      `agents.claude: auth.placeholderEnv.TYPESAFE_API_KEY is also set in ${source}, which would override it`,
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
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: auth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});

test('it refuses apiKeyHelper on an entry without a baseURL', () => {
  expect(
    collectAgents({ claude: { apiKeyHelper: 'op read x' } }, new Map(), [buildClaudePlugin()]),
  ).toStrictEqual({
    agents: [],
    errors: ['agents.claude: apiKeyHelper is only valid together with baseURL'],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.claude: settings.apiKeyHelper must not be set, which would override the subscription sign-in',
    ],
  });
});

test('it loads the same env and settings on a stock entry without auth', () => {
  const result = collectAgents(
    {
      claude: {
        env: { ANTHROPIC_BASE_URL: 'https://x.example.com', HTTPS_PROXY: 'http://p.example:3128' },
        settings: { apiKeyHelper: 'op read x', env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
      },
    },
    new Map(),
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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
    [buildClaudePlugin()],
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

test('it reads the auth profiles a config sets and registers a claude entry whose auth selects them', () => {
  const config = parseConfig([buildClaudePlugin()], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    },
  });

  expect(config.agents).toStrictEqual([
    {
      id: 'glm',
      kind: 'claude',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
  ]);

  expect(config.agentErrors).toStrictEqual([]);
});

test('it refuses a gateway whose auth selects a profile the config refused, and reports both', () => {
  const config = parseConfig([buildClaudePlugin()], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'basic' },
    },
    agents: {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'] },
      },
    },
  });

  expect(config.agents).toStrictEqual([]);

  expect(config.agentErrors).toStrictEqual([
    'agents.glm: profile glm is selected, but authProfiles has no usable profile by that name',
  ]);

  expect(config.authProfileErrors).toStrictEqual([
    'authProfiles.glm: scheme must be bearer or raw, the schemes atc binds',
  ]);
});

test('it creates a stock claude adapter for an entry without a base URL', () => {
  const adapter = buildClaudePlugin().create(
    {
      entry: {
        id: 'claude-b',
        kind: 'claude',
        label: 'Claude B',
        mark: 'b',
        bin: 'claude',
        args: [],
        env: {},
      },
      warnings: [],
    },
    buildMockHostServices(),
    { authProfiles: new Map() },
  );

  expect(adapter).toBeInstanceOf(ClaudeAdapter);
  expect(adapter.id).toBe('claude-b');
});

test('it creates a gateway adapter for an entry with a base URL', () => {
  const adapter = buildClaudePlugin().create(
    {
      entry: {
        id: 'zai',
        kind: 'claude',
        label: 'GLM',
        mark: 'z',
        bin: 'claude',
        args: [],
        env: {},
        baseURL: 'https://api.z.ai/api/anthropic',
      },
      warnings: [],
    },
    buildMockHostServices(),
    { authProfiles: new Map() },
  );

  expect(adapter).toBeInstanceOf(GatewayAdapter);
  expect(adapter.id).toBe('zai');
});
