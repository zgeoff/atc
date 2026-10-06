import { expect, test } from 'bun:test';
import { collectAuthProfiles } from './collect-auth-profiles';
import { collectClaudeAuth } from './collect-claude-auth';

test('it reads a selection whose profiles send a bearer authorization header to the Anthropic API', () => {
  const profiles = collectAuthProfiles({
    claude: {
      secret: 'claude-setup-token',
      host: 'api.anthropic.com',
      header: 'authorization',
      scheme: 'bearer',
    },
    github: { secret: 'github-imp-agents', kind: 'github' },
  }).profiles;

  expect(collectClaudeAuth({ profiles: ['claude', 'github'] }, profiles)).toStrictEqual({
    auth: { profiles: ['claude', 'github'] },
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
  const profiles = collectAuthProfiles({
    claude: {
      secret: 'claude-setup-token',
      host: 'api.anthropic.com',
      header: 'authorization',
      scheme: 'bearer',
    },
  }).profiles;

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
  const result = collectClaudeAuth({ profiles: ['claude'] }, new Map());

  expect(result).toStrictEqual({ auth: null, errors: [expect.toStartWith('claudeAuth: ')] });
});

test('it refuses a selection whose profiles send no credential to the Anthropic API', () => {
  const profiles = collectAuthProfiles({
    github: { secret: 'github-imp-agents', kind: 'github' },
  }).profiles;

  expect(collectClaudeAuth({ profiles: ['github'] }, profiles)).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});

test('it refuses a selection that sends the Anthropic API a header other than authorization', () => {
  const profiles = collectAuthProfiles({
    claude: {
      secret: 'claude-api-key',
      host: 'api.anthropic.com',
      header: 'x-api-key',
      scheme: 'bearer',
    },
  }).profiles;

  expect(collectClaudeAuth({ profiles: ['claude'] }, profiles)).toStrictEqual({
    auth: null,
    errors: [
      'claudeAuth needs a profile that sets a bearer authorization header for api.anthropic.com, where Claude Code sends its subscription token',
    ],
  });
});
