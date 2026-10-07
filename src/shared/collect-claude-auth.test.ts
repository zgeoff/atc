import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '../test-utils/build-mock-auth-profile';
import type { AuthProfile } from './collect-auth-profiles';
import { collectClaudeAuth } from './collect-claude-auth';

test('it reads a selection whose profiles send a bearer authorization header to the Anthropic API', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'claude',
      buildMockAuthProfile({ name: 'claude', host: 'api.anthropic.com', header: 'authorization' }),
    ],
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(collectClaudeAuth({ profiles: ['claude', 'github'] }, profiles)).toStrictEqual({
    auth: { profiles: ['claude', 'github'], mcpServers: [] },
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

test('it refuses an entry that sets the endpoint or the placeholder itself', () => {
  const profiles = new Map<string, AuthProfile>([
    [
      'claude',
      buildMockAuthProfile({ name: 'claude', host: 'api.anthropic.com', header: 'authorization' }),
    ],
  ]);

  expect(
    collectClaudeAuth(
      { profiles: ['claude'], placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' } },
      profiles,
    ),
  ).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth.placeholderEnv cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
    ],
  });
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
      buildMockAuthProfile({ name: 'claude', host: 'api.anthropic.com', header: 'authorization' }),
    ],
    [
      'linear',
      buildMockAuthProfile({ name: 'linear', host: 'mcp.linear.app', header: 'authorization' }),
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
      buildMockAuthProfile({ name: 'claude', host: 'api.anthropic.com', header: 'authorization' }),
    ],
    [
      'linear',
      buildMockAuthProfile({ name: 'linear', host: 'mcp.linear.app', header: 'authorization' }),
    ],
    [
      'unselected',
      buildMockAuthProfile({ name: 'unselected', host: 'mcp.linear.app', header: 'authorization' }),
    ],
    ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
  ]);

  expect(
    collectClaudeAuth({ profiles: ['claude', 'linear', 'github'], mcpServers }, profiles),
  ).toStrictEqual({
    auth: { profiles: ['claude', 'linear', 'github'], mcpServers: [] },
    errors: [error],
  });
});
