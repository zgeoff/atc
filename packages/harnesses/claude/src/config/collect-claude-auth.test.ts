import { expect, test } from 'bun:test';
import type { AuthProfile } from '@atc/plugin-api/auth-profile';
import { buildMockAuthProfile } from '@atc/test-utils/build-mock-auth-profile';
import { collectClaudeAuth } from './collect-claude-auth';

test('it reads a selection whose profiles send a bearer authorization header to the Anthropic API', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'claude',
      buildMockAuthProfile({
        name: 'claude',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      }),
    ],
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(collectClaudeAuth({ profiles: ['claude', 'github'] }, profiles)).toStrictEqual({
    auth: { profiles: ['claude', 'github'], placeholderEnv: {}, mcpServers: [] },
    errors: [],
  });
});

test('it reads no selection and reports nothing when the entry is absent', () => {
  expect(collectClaudeAuth(undefined, new Map())).toStrictEqual({ auth: null, errors: [] });
});

test.each([
  [null],
  [{}],
  [{ profiles: [] }],
  [{ profiles: ['claude', 3] }],
  [{ profiles: 'claude' }],
])('it refuses the malformed entry %p', (raw) => {
  expect(collectClaudeAuth(raw, new Map())).toStrictEqual({
    auth: null,
    errors: ['claudeAuth must be an object with a non-empty profiles array'],
  });
});

test('it refuses an entry that sets a key atc does not read', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'claude',
      buildMockAuthProfile({
        name: 'claude',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      }),
    ],
  ]);

  expect(
    collectClaudeAuth({ profiles: ['claude'], baseURL: 'https://api.z.ai' }, profiles),
  ).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth.baseURL cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
    ],
  });
});

test("it reads a placeholder that stands in for a selected non-Anthropic profile's key", () => {
  const profiles = new Map<string, AuthProfile>([
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
  ]);

  expect(
    collectClaudeAuth(
      { profiles: ['claude', 'jev'], placeholderEnv: { TYPESAFE_API_KEY: { profile: 'jev' } } },
      profiles,
    ),
  ).toStrictEqual({
    auth: {
      profiles: ['claude', 'jev'],
      placeholderEnv: { TYPESAFE_API_KEY: 'imp-broker-placeholder' },
      mcpServers: [],
    },
    errors: [],
  });
});

test.each([
  [
    { ANTHROPIC_API_KEY: { profile: 'jev' } },
    'claudeAuth.placeholderEnv.ANTHROPIC_API_KEY: atc fixes the endpoint and the placeholder of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, proxy or CA variable',
  ],
  [
    { ANTHROPIC_BASE_URL: { profile: 'jev' } },
    'claudeAuth.placeholderEnv.ANTHROPIC_BASE_URL: atc fixes the endpoint and the placeholder of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, proxy or CA variable',
  ],
  [
    { CLAUDE_CODE_OAUTH_TOKEN: { profile: 'jev' } },
    'claudeAuth.placeholderEnv.CLAUDE_CODE_OAUTH_TOKEN: atc fixes the endpoint and the placeholder of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, proxy or CA variable',
  ],
  [
    { anthropic_custom_key: { profile: 'jev' } },
    'claudeAuth.placeholderEnv.anthropic_custom_key: atc fixes the endpoint and the placeholder of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, proxy or CA variable',
  ],
  [
    { https_proxy: { profile: 'jev' } },
    'claudeAuth.placeholderEnv.https_proxy: atc fixes the endpoint and the placeholder of a Claude subscription session, so a placeholder cannot set an Anthropic, Claude Code, proxy or CA variable',
  ],
  [
    { TYPESAFE_API_KEY: 'imp-broker-placeholder' },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: a placeholder must be an object with the profile whose credential it stands in for',
  ],
  [
    { TYPESAFE_API_KEY: {} },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: profile must be one of claudeAuth.profiles',
  ],
  [
    { TYPESAFE_API_KEY: { profile: 'unselected' } },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: profile must be one of claudeAuth.profiles',
  ],
  [
    { TYPESAFE_API_KEY: { profile: 'claude' } },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: profile claude sends its credential to api.anthropic.com, and atc fixes the placeholder of a credential sent to Anthropic',
  ],
  [
    { TYPESAFE_API_KEY: { profile: 'console' } },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: profile console sends its credential to Console.Anthropic.com, and atc fixes the placeholder of a credential sent to Anthropic',
  ],
  [
    { TYPESAFE_API_KEY: { profile: 'claudeai' } },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: profile claudeai sends its credential to claude.ai, and atc fixes the placeholder of a credential sent to Anthropic',
  ],
  [
    { GH_TOKEN: { profile: 'github' } },
    'claudeAuth.placeholderEnv.GH_TOKEN: profile must be a custom or oauth profile, which sets one header for one host',
  ],
  [
    { TYPESAFE_API_KEY: { profile: 'jev', value: 'sk-typesafe' } },
    'claudeAuth.placeholderEnv.TYPESAFE_API_KEY: value cannot be set: atc fixes the placeholder value',
  ],
  [
    { '1KEY': { profile: 'jev' } },
    'claudeAuth.placeholderEnv.1KEY: a variable name must be letters, digits or underscores, and not start with a digit',
  ],
  [['TYPESAFE_API_KEY'], 'claudeAuth.placeholderEnv must be an object of variable names'],
])('it refuses the whole entry for the placeholders %p', (placeholderEnv, error) => {
  const profiles = new Map<string, AuthProfile>([
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
    [
      'unselected',
      buildMockAuthProfile({
        name: 'unselected',
        host: 'api.typesafe.ai',
        header: 'authorization',
        scheme: 'bearer',
      }),
    ],
    [
      'console',
      buildMockAuthProfile({ name: 'console', host: 'Console.Anthropic.com', header: 'x-api-key' }),
    ],
    ['claudeai', buildMockAuthProfile({ name: 'claudeai', host: 'claude.ai', header: 'cookie' })],
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(
    collectClaudeAuth(
      { profiles: ['claude', 'jev', 'console', 'claudeai', 'github'], placeholderEnv },
      profiles,
    ),
  ).toStrictEqual({ auth: null, errors: [error] });
});

test('it refuses a selection that reaches a profile the config does not hold', () => {
  expect(collectClaudeAuth({ profiles: ['claude'] }, new Map())).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth: profile claude is selected, but authProfiles has no usable profile by that name',
    ],
  });
});

test('it refuses a selection whose profiles send no credential to the Anthropic API', () => {
  const profiles = new Map<string, AuthProfile>([
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(collectClaudeAuth({ profiles: ['github'] }, profiles)).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});

test('it refuses a selection that sends the Anthropic API a header other than authorization', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'claude',
      buildMockAuthProfile({ name: 'claude', host: 'api.anthropic.com', header: 'x-api-key' }),
    ],
  ]);

  expect(collectClaudeAuth({ profiles: ['claude'] }, profiles)).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});

test("it reads an MCP server on a selected profile's host with that profile's header", () => {
  const profiles = new Map<string, AuthProfile>([
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
  ]);

  expect(
    collectClaudeAuth(
      {
        profiles: ['claude', 'linear'],
        mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
      },
      profiles,
    ),
  ).toStrictEqual({
    auth: {
      profiles: ['claude', 'linear'],
      placeholderEnv: {},
      mcpServers: [
        {
          name: 'linear',
          url: 'https://mcp.linear.app/mcp',
          profile: 'linear',
          header: 'authorization',
        },
      ],
    },
    errors: [],
  });
});

test.each([
  [
    { linear: { url: 'https://api.linear.app/mcp', profile: 'linear' } },
    'claudeAuth.mcpServers.linear: url must be on mcp.linear.app, the host profile linear sends its credential to',
  ],
  [
    { linear: { url: 'http://mcp.linear.app/mcp', profile: 'linear' } },
    'claudeAuth.mcpServers.linear: url must be an https URL with no port and no user info',
  ],
  [
    { linear: { url: 'https://mcp.linear.app:8443/mcp', profile: 'linear' } },
    'claudeAuth.mcpServers.linear: url must be an https URL with no port and no user info',
  ],
  [
    { linear: { url: 'https://me@mcp.linear.app/mcp', profile: 'linear' } },
    'claudeAuth.mcpServers.linear: url must be an https URL with no port and no user info',
  ],
  [
    { linear: { url: 'https://mcp.linear.app/mcp', profile: 'unselected' } },
    'claudeAuth.mcpServers.linear: profile must be one of claudeAuth.profiles',
  ],
  [
    { github: { url: 'https://api.github.com/mcp', profile: 'github' } },
    'claudeAuth.mcpServers.github: profile must be a custom profile, which sets one header for one host',
  ],
  [
    {
      linear: {
        url: 'https://mcp.linear.app/mcp',
        profile: 'linear',
        headers: { authorization: 'Bearer lin_api_x' },
      },
    },
    'claudeAuth.mcpServers.linear: headers cannot be set: atc fixes the transport and the placeholder header',
  ],
  [
    { 'lin ear': { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
    'claudeAuth.mcpServers.lin ear: a server name must be letters, digits, underscores or hyphens',
  ],
  [
    { linear: 'https://mcp.linear.app/mcp' },
    'claudeAuth.mcpServers.linear: a server must be an object with url and profile',
  ],
  [['linear'], 'claudeAuth.mcpServers must be an object of named servers'],
])('it leaves out the MCP servers %p and keeps the sign-in', (mcpServers, error) => {
  const profiles = new Map<string, AuthProfile>([
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
    [
      'unselected',
      buildMockAuthProfile({
        name: 'unselected',
        host: 'mcp.linear.app',
        header: 'authorization',
        scheme: 'bearer',
      }),
    ],
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(
    collectClaudeAuth({ profiles: ['claude', 'linear', 'github'], mcpServers }, profiles),
  ).toStrictEqual({
    auth: { profiles: ['claude', 'linear', 'github'], placeholderEnv: {}, mcpServers: [] },
    errors: [error],
  });
});
