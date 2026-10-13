import { expect, test } from 'bun:test';
import { collectLegacyAgents } from './collect-legacy-agents';

test('it translates the old agent keys into agents in a fixed order, then each gateway in file order', () => {
  const legacy = collectLegacyAgents(
    {
      claudeBin: '/opt/claude',
      claudeArgs: ['--verbose'],
      claudeAuth: { profiles: ['claude'] },
      grokBin: 'my-grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: ['--search'],
      gateways: {
        inherits: { baseURL: 'https://one.example.com' },
        own: {
          baseURL: 'https://two.example.com',
          bin: '/opt/other',
          args: ['--x'],
          label: 'Two',
          mark: 'T',
          env: { A: 'b', C: 3 },
        },
        noURL: { label: 'No URL' },
        claude: { baseURL: 'https://three.example.com' },
        glm: { baseURL: 'https://api.z.ai/api/anthropic', auth: { profiles: ['glm'] } },
      },
    },
    new Map([
      [
        'claude',
        {
          name: 'claude',
          secret: 'claude-setup-token',
          kind: 'custom',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
  );

  expect(legacy).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: '/opt/claude',
        args: ['--verbose'],
        env: {},
        auth: { profiles: ['claude'], placeholderEnv: {} },
      },
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'my-grok', args: [], env: {} },
      {
        id: 'codex',
        kind: 'codex',
        label: 'Codex',
        mark: 'c',
        bin: 'codex',
        args: ['--search'],
        env: {},
      },
      {
        id: 'inherits',
        kind: 'claude',
        label: 'inherits',
        mark: 'i',
        bin: '/opt/claude',
        args: ['--verbose'],
        baseURL: 'https://one.example.com',
        env: {},
      },
      {
        id: 'own',
        kind: 'claude',
        label: 'Two',
        mark: 'T',
        bin: '/opt/other',
        args: ['--x'],
        baseURL: 'https://two.example.com',
        env: { A: 'b' },
      },
    ],
    errors: [
      'gateways.glm: profile glm is selected, but authProfiles has no usable profile by that name',
    ],
  });
});

test('it gives each built-in agent its default bin and no args for keys left at their defaults', () => {
  const legacy = collectLegacyAgents(
    {
      claudeBin: 'claude',
      claudeArgs: [],
      claudeAuth: undefined,
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      gateways: undefined,
    },
    new Map(),
  );

  expect(legacy).toStrictEqual({
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
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it leaves out an old Claude auth that sets placeholders, which only the agents map takes', () => {
  const legacy = collectLegacyAgents(
    {
      claudeBin: 'claude',
      claudeArgs: [],
      claudeAuth: {
        profiles: ['claude', 'jev'],
        placeholderEnv: { TYPESAFE_API_KEY: { profile: 'jev' } },
      },
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      gateways: undefined,
    },
    new Map([
      [
        'claude',
        {
          name: 'claude',
          secret: 'claude-setup-token',
          kind: 'custom',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
      [
        'jev',
        {
          name: 'jev',
          secret: 'jev-imp-agents',
          kind: 'custom',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
  );

  expect(legacy).toStrictEqual({
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
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
    ],
    errors: [
      'claudeAuth.placeholderEnv cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session',
    ],
  });
});
