import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config';
import type { AuthProfile } from '@atc/plugin-api';
import { buildMockAuthProfile, buildMockHostServices } from '@atc/test-utils';
import { CodexAdapter } from './codex-adapter';
import { CODEX_PLUGIN } from './codex-plugin';

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
    [CODEX_PLUGIN],
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
      ['github', buildMockAuthProfile({ kind: 'github', name: 'github' })],
    ]),
    [CODEX_PLUGIN],
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
        'codex-custom',
        buildMockAuthProfile({
          name: 'codex-custom',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    [CODEX_PLUGIN],
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
        'codex-raw',
        buildMockAuthProfile({
          name: 'codex-raw',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'x-token',
          scheme: 'bearer',
        }),
      ],
    ]),
    [CODEX_PLUGIN],
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
    ]),
    [CODEX_PLUGIN],
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
    ]),
    [CODEX_PLUGIN],
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
    ]),
    [CODEX_PLUGIN],
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
    ]),
    [CODEX_PLUGIN],
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: [
      'agents.codex: auth.placeholderEnv cannot be set: atc fixes the endpoint and the sign-in of a Codex session',
    ],
  });
});

test('it creates a codex adapter for an entry', () => {
  const adapter = CODEX_PLUGIN.create(
    {
      entry: {
        id: 'codex-b',
        kind: 'codex',
        label: 'Codex B',
        mark: 'b',
        bin: 'codex',
        args: [],
        env: {},
      },
      warnings: [],
    },
    buildMockHostServices(),
    { authProfiles: new Map() },
  );

  expect(adapter).toBeInstanceOf(CodexAdapter);
  expect(adapter.id).toBe('codex-b');
});
