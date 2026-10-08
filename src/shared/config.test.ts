import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { loadConfig, parseConfig, renderDefaultConfig } from './config';

function setupTest() {
  const tmp = setupTempDir('atc-config-');

  return { dir: tmp.dir };
}

test('#parseConfig leaves every target unusable, local included, and grants no principal a target when the root is not an object', () => {
  expect(parseConfig(null, '/home/u/.config/atc/config.json')).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [],
    defaultTarget: null,
    targetErrors: [
      {
        scope: 'config',
        problem: 'config_malformed',
        path: '/home/u/.config/atc/config.json',
        detail: 'the root is null, not an object',
      },
    ],
    principals: new Map(),
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test.each([
  [[], 'the root is an array, not an object'],
  ['garbage', 'the root is a string, not an object'],
  [42, 'the root is a number, not an object'],
  [true, 'the root is a boolean, not an object'],
])('#parseConfig reports a malformed config when the root is %p', (raw, detail) => {
  expect(parseConfig(raw, '/c.json').targetErrors).toStrictEqual([
    { scope: 'config', problem: 'config_malformed', path: '/c.json', detail },
  ]);
});

test('#parseConfig falls back field by field when a field is wrong-typed instead of failing the whole file', () => {
  const config = parseConfig({
    claudeBin: 7,
    claudeArgs: 'not-an-array',
    grokBin: 'my-grok',
    grokArgs: ['--yolo', 3, null],
    leader: 3,
  });

  expect(config).toStrictEqual({
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
      {
        id: 'grok',
        kind: 'grok',
        label: 'Grok',
        mark: 'g',
        bin: 'my-grok',
        args: ['--yolo'],
        env: {},
      },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
    ],
    agentErrors: [],
    legacyAgentKeys: ['claudeBin', 'claudeArgs', 'grokBin', 'grokArgs'],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig decodes a configured leader key', () => {
  expect(parseConfig({ leader: 'ctrl-a' }).leader).toStrictEqual({ code: 1, label: '^A' });
});

test('#parseConfig falls back to the default leader key for an unknown one', () => {
  expect(parseConfig({ leader: 'ctrl-nope' }).leader).toStrictEqual({ code: 0, label: '^Space' });
});

test('#parseConfig translates the old gateway map into agents using the parsed claude bin and args', () => {
  const config = parseConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  expect(config).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: '/opt/claude',
        args: ['--verbose'],
        env: {},
      },
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
      {
        id: 'zai',
        kind: 'claude',
        label: 'zai',
        mark: 'z',
        bin: '/opt/claude',
        args: ['--verbose'],
        baseURL: 'https://api.z.ai/api/anthropic',
        env: {},
      },
    ],
    agentErrors: [],
    legacyAgentKeys: ['claudeBin', 'claudeArgs', 'gateways'],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig collects the configured hooks map', () => {
  const config = parseConfig({
    hooks: { SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }] },
  });

  expect(config.hooks).toStrictEqual({
    SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }],
  });
});

test('#parseConfig collects the configured directory roots, expanding a leading tilde to the home', () => {
  const config = parseConfig(
    { dirs: { roots: ['~/projects/', '/srv/work', 7, ''] } },
    '/c.json',
    '/home/someone',
  );

  expect(config.dirs).toStrictEqual({ roots: ['/home/someone/projects', '/srv/work'] });
});

test('#parseConfig expands a leading tilde in a hook dir to the home', () => {
  const config = parseConfig(
    { hooks: { SessionAttached: [{ command: 'ork focus', dir: '~/w' }] } },
    '/c.json',
    '/home/someone',
  );

  expect(config.hooks).toStrictEqual({
    SessionAttached: [{ command: 'ork focus', dir: '/home/someone/w' }],
  });
});

test('#parseConfig reads the targets and default target a config sets', () => {
  const config = parseConfig({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'imp', image: 'dev' } },
    defaultTarget: 'box',
  });

  expect(config).toStrictEqual({
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
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: { image: 'dev' } },
    ],
    defaultTarget: 'box',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig reads the principals a config sets', () => {
  const config = parseConfig({ principals: { 'client-a': { targets: ['local'] } } });

  expect(config).toStrictEqual({
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
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: new Map([['client-a', ['local']]]),
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig holds no targets and an error instead of throwing for a malformed targets map', () => {
  const config = parseConfig({ agents: { claude: { bin: 'my-claude' } }, targets: ['local'] });

  expect(config).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'my-claude',
        args: [],
        env: {},
      },
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [],
    defaultTarget: null,
    targetErrors: [
      { scope: 'targets', problem: 'targets must be a non-empty object of named targets' },
    ],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig reads the config a first run writes back as the defaults, without target errors', () => {
  const written: unknown = JSON.parse(renderDefaultConfig());

  expect(parseConfig(written)).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig reads the auth profiles a config sets and registers a claude entry whose auth selects them', () => {
  const config = parseConfig({
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

  expect(config).toStrictEqual({
    agents: [
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'glm',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map([
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
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig refuses a gateway whose auth selects a profile the config refused, and reports both', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'raw' },
    },
    agents: {
      glm: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'] },
      },
    },
  });

  expect(config).toStrictEqual({
    agents: [],
    agentErrors: [
      'agents.glm: profile glm is selected, but authProfiles has no usable profile by that name',
    ],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: ['authProfiles.glm: scheme must be bearer, the one scheme atc binds'],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig translates the old agent keys into agents in a fixed order and records the keys', () => {
  const config = parseConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    claudeAuth: { profiles: ['claude'] },
    grokBin: 'my-grok',
    codexArgs: ['--search'],
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'raw' },
    },
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
  });

  expect(config).toStrictEqual({
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
    agentErrors: [
      'gateways.glm: profile glm is selected, but authProfiles has no usable profile by that name',
    ],
    legacyAgentKeys: ['claudeBin', 'claudeArgs', 'claudeAuth', 'grokBin', 'codexArgs', 'gateways'],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map([
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
    authProfileErrors: ['authProfiles.glm: scheme must be bearer, the one scheme atc binds'],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig gives a file with no agent keys at all the three built-in agents and no old keys', () => {
  const config = parseConfig({ leader: 'ctrl-a' });

  expect(config).toStrictEqual({
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
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 1, label: '^A' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig loads exactly the agents an agents map holds and records no old keys', () => {
  const config = parseConfig({
    agents: { codex: {}, 'claude-b': { kind: 'claude' } },
  });

  expect(config).toStrictEqual({
    agents: [
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
      {
        id: 'claude-b',
        kind: 'claude',
        label: 'claude-b',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'codex',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig defaults to claude when the registry holds that id, wherever it sits', () => {
  const config = parseConfig({ agents: { codex: {}, claude: {} } });

  expect(config.defaultAgent).toBe('claude');
});

test('#parseConfig keeps reporting claude as the default agent for an empty registry', () => {
  const config = parseConfig({ agents: {} });

  expect(config).toStrictEqual({
    agents: [],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig leaves the registry empty with one error when agents is not an object', () => {
  const config = parseConfig({ agents: [] });

  expect(config).toStrictEqual({
    agents: [],
    agentErrors: ['agents must be an object of agent entries'],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig refuses a config that sets agents beside an old agent key', () => {
  const config = parseConfig({ agents: {}, claudeArgs: [] }, '/c.json');

  expect(config).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [],
    defaultTarget: null,
    targetErrors: [
      {
        scope: 'config',
        problem: 'config_malformed',
        path: '/c.json',
        detail:
          "claudeArgs cannot be set together with agents; move them into agents or run 'atc config migrate'",
      },
    ],
    principals: new Map(),
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig lists every old key a mixed config sets, in file order', () => {
  const config = parseConfig(
    { gateways: {}, agents: {}, claudeBin: 'x', codexArgs: [] },
    '/c.json',
  );

  expect(config.targetErrors).toStrictEqual([
    {
      scope: 'config',
      problem: 'config_malformed',
      path: '/c.json',
      detail:
        "gateways, claudeBin and codexArgs cannot be set together with agents; move them into agents or run 'atc config migrate'",
    },
  ]);
});

test('#parseConfig restores the fleet on restart by default', () => {
  const config = parseConfig({});

  expect(config).toStrictEqual({
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
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#parseConfig reads restoreFleetOnRestart set to false', () => {
  expect(parseConfig({ restoreFleetOnRestart: false }).restoreFleetOnRestart).toBe(false);
});

test('#parseConfig loads a config that still sets resumeInterruptedTurns and reports the key without its value', () => {
  const config = parseConfig({ resumeInterruptedTurns: true, leader: 'ctrl-a' });

  expect(config).toStrictEqual({
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
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 1, label: '^A' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: ['resumeInterruptedTurns'],
  });
});

test('#renderDefaultConfig writes an agents map with the claude entry and no old agent key', () => {
  expect(JSON.parse(renderDefaultConfig())).toStrictEqual({
    agents: { claude: {} },
    dirs: { roots: [] },
    hooks: {},
    leader: { code: 0, label: '^Space' },
    restoreFleetOnRestart: true,
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targets: {},
    },
  });
});

test('#loadConfig writes the default config when the file is missing', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  loadConfig(file, join(ctx.dir, 'home'), join(ctx.dir, 'state'));

  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
    agents: { claude: {} },
    dirs: { roots: [] },
    hooks: {},
    leader: { code: 0, label: '^Space' },
    restoreFleetOnRestart: true,
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targets: {},
    },
  });
});

test('#loadConfig returns the defaults when the file is missing', () => {
  const ctx = setupTest();

  expect(
    loadConfig(join(ctx.dir, 'config.json'), join(ctx.dir, 'home'), join(ctx.dir, 'state')),
  ).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#loadConfig reads an existing file against the home it is given', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(
    file,
    JSON.stringify({ agents: { claude: { bin: '/opt/claude' } }, dirs: { roots: ['~/projects'] } }),
  );

  expect(loadConfig(file, join(ctx.dir, 'home'), join(ctx.dir, 'state'))).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: '/opt/claude',
        args: [],
        env: {},
      },
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [join(ctx.dir, 'home', 'projects')] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#loadConfig creates the state directory it is given', () => {
  const ctx = setupTest();
  const state = join(ctx.dir, 'state', 'atc');

  loadConfig(join(ctx.dir, 'config.json'), join(ctx.dir, 'home'), state);

  expect(readdirSync(state)).toBeEmpty();
});

test('#loadConfig never overwrites an existing file it cannot use', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, '{ "agents": ');
  loadConfig(file, join(ctx.dir, 'home'), join(ctx.dir, 'state'));

  expect(readFileSync(file, 'utf8')).toBe('{ "agents": ');
});

test('#loadConfig leaves every target unusable when the file cannot be read', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  mkdirSync(file);

  expect(loadConfig(file, join(ctx.dir, 'home'), join(ctx.dir, 'state'))).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [],
    defaultTarget: null,
    targetErrors: [{ scope: 'config', problem: 'config_unreadable', path: file, detail: 'EISDIR' }],
    principals: new Map(),
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});

test('#loadConfig leaves every target unusable when the file is not valid JSON', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, '{ "agents": ');

  expect(loadConfig(file, join(ctx.dir, 'home'), join(ctx.dir, 'state'))).toStrictEqual({
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
    ],
    agentErrors: [],
    legacyAgentKeys: [],
    defaultAgent: 'claude',
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [],
    defaultTarget: null,
    targetErrors: [
      {
        scope: 'config',
        problem: 'config_malformed',
        path: file,
        detail: 'the file is not valid JSON',
      },
    ],
    principals: new Map(),
    principalErrors: [],
    workspaceErrors: [],
    restoreFleetOnRestart: true,
    removedKeys: [],
  });
});
