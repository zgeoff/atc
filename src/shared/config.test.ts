import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { loadConfig, parseConfig, renderDefaultConfig } from './config';
import { getRecord } from './get-record';

test('it leaves every target unusable, local included, and grants no principal a target when the root is not an object', () => {
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
])('it reports a malformed config when the root is %p', (raw, detail) => {
  expect(parseConfig(raw, '/c.json').targetErrors).toStrictEqual([
    { scope: 'config', problem: 'config_malformed', path: '/c.json', detail },
  ]);
});

test('it falls back field by field when a field is wrong-typed instead of failing the whole file', () => {
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

test('it decodes a configured leader key and falls back to the default for an unknown one', () => {
  expect(parseConfig({ leader: 'ctrl-a' }).leader).toStrictEqual({ code: 1, label: '^A' });
  expect(parseConfig({ leader: 'ctrl-nope' }).leader).toStrictEqual({ code: 0, label: '^Space' });
});

test('it translates the old gateway map into agents using the parsed claude bin and args', () => {
  const config = parseConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  expect(config.agents.slice(3)).toStrictEqual([
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
  ]);
});

test('it collects the configured hooks map', () => {
  const config = parseConfig({
    hooks: { SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }] },
  });

  expect(config.hooks).toStrictEqual({
    SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }],
  });
});

test('it collects the configured directory roots with the home directory expanded', () => {
  const config = parseConfig({ dirs: { roots: ['~/projects/', '/srv/work', 7, ''] } });

  expect(config.dirs).toStrictEqual({ roots: [join(homedir(), 'projects'), '/srv/work'] });
});

test('it reads the targets and default target a config sets', () => {
  const config = parseConfig({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'imp', image: 'dev' } },
    defaultTarget: 'box',
  });

  expect({
    targets: config.targets,
    defaultTarget: config.defaultTarget,
    targetErrors: config.targetErrors,
  }).toStrictEqual({
    targets: [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: { image: 'dev' } },
    ],
    defaultTarget: 'box',
    targetErrors: [],
  });
});

test('it reads the principals a config sets', () => {
  const config = parseConfig({ principals: { 'client-a': { targets: ['local'] } } });

  expect({
    principals: config.principals,
    principalErrors: config.principalErrors,
  }).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    principalErrors: [],
  });
});

test('it holds no targets and an error instead of throwing for a malformed targets map', () => {
  const config = parseConfig({ agents: { claude: { bin: 'my-claude' } }, targets: ['local'] });

  expect({
    claudeBin: config.agents[0]?.bin,
    targets: config.targets,
    defaultTarget: config.defaultTarget,
    targetErrors: config.targetErrors,
  }).toStrictEqual({
    claudeBin: 'my-claude',
    targets: [],
    defaultTarget: null,
    targetErrors: [
      { scope: 'targets', problem: 'targets must be a non-empty object of named targets' },
    ],
  });
});

test('it reads the config a first run writes back as the defaults, without target errors', () => {
  const written: unknown = JSON.parse(renderDefaultConfig());
  const config = parseConfig(written);

  expect(config).toStrictEqual(parseConfig({ agents: { claude: {} } }));
  expect(config.targetErrors).toStrictEqual([]);
});

test('it reads the auth profiles a config sets and registers a claude entry whose auth selects them', () => {
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

  expect({
    authProfiles: config.authProfiles,
    authProfileErrors: config.authProfileErrors,
    agents: config.agents,
    agentErrors: config.agentErrors,
  }).toStrictEqual({
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
  });
});

test('it refuses a gateway whose auth selects a profile the config refused, and reports both', () => {
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

  expect({
    authProfileErrors: config.authProfileErrors,
    agents: config.agents,
    agentErrors: config.agentErrors,
  }).toStrictEqual({
    authProfileErrors: ['authProfiles.glm: scheme must be bearer, the one scheme atc binds'],
    agents: [],
    agentErrors: [
      'agents.glm: profile glm is selected, but authProfiles has no usable profile by that name',
    ],
  });
});

test('it translates the old agent keys into agents in a fixed order and records the keys', () => {
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

  expect({
    agents: config.agents,
    agentErrors: config.agentErrors,
    legacyAgentKeys: config.legacyAgentKeys,
    defaultAgent: config.defaultAgent,
  }).toStrictEqual({
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
  });
});

test('it gives a file with no agent keys at all the three built-in agents and no old keys', () => {
  const config = parseConfig({ leader: 'ctrl-a' });

  expect({
    ids: config.agents.map((entry) => entry.id),
    legacyAgentKeys: config.legacyAgentKeys,
  }).toStrictEqual({ ids: ['claude', 'grok', 'codex'], legacyAgentKeys: [] });
});

test('it loads exactly the agents an agents map holds and records no old keys', () => {
  const config = parseConfig({
    agents: { codex: {}, 'claude-b': { kind: 'claude' } },
  });

  expect({
    ids: config.agents.map((entry) => entry.id),
    legacyAgentKeys: config.legacyAgentKeys,
    defaultAgent: config.defaultAgent,
  }).toStrictEqual({ ids: ['codex', 'claude-b'], legacyAgentKeys: [], defaultAgent: 'codex' });
});

test('it defaults to claude when the registry holds that id, wherever it sits', () => {
  const config = parseConfig({ agents: { codex: {}, claude: {} } });

  expect(config.defaultAgent).toBe('claude');
});

test('it keeps reporting claude as the default agent for an empty registry', () => {
  const config = parseConfig({ agents: {} });

  expect({ agents: config.agents, defaultAgent: config.defaultAgent }).toStrictEqual({
    agents: [],
    defaultAgent: 'claude',
  });
});

test('it leaves the registry empty with one error when agents is not an object', () => {
  const config = parseConfig({ agents: [] });

  expect({ agents: config.agents, agentErrors: config.agentErrors }).toStrictEqual({
    agents: [],
    agentErrors: ['agents must be an object of agent entries'],
  });
});

test('it refuses a config that sets agents beside an old agent key', () => {
  const config = parseConfig({ agents: {}, claudeArgs: [] }, '/c.json');

  expect({ targets: config.targets, targetErrors: config.targetErrors }).toStrictEqual({
    targets: [],
    targetErrors: [
      {
        scope: 'config',
        problem: 'config_malformed',
        path: '/c.json',
        detail:
          "claudeArgs cannot be set together with agents; move them into agents or run 'atc config migrate'",
      },
    ],
  });
});

test('it lists every old key a mixed config sets, in file order', () => {
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

test('it writes a first-run config with an agents map and no old agent key', () => {
  const written: unknown = JSON.parse(renderDefaultConfig());
  const record = getRecord({ written }, 'written');

  expect(Object.keys(record)).not.toIncludeAnyMembers([
    'claudeBin',
    'claudeArgs',
    'claudeAuth',
    'grokBin',
    'grokArgs',
    'codexBin',
    'codexArgs',
    'gateways',
  ]);

  expect(record['agents']).toStrictEqual({ claude: {} });
});

test('it writes the default config when the file is missing', () => {
  using tmp = setupTempDir('atc-config-first-run-');

  const file = `${tmp.dir}/config.json`;
  const config = loadConfig(file);
  const written: unknown = JSON.parse(readFileSync(file, 'utf8'));

  expect({
    ids: config.agents.map((entry) => entry.id),
    written: getRecord({ written }, 'written')['agents'],
  }).toStrictEqual({ ids: ['claude'], written: { claude: {} } });
});

test('it restores the fleet on restart by default', () => {
  const config = parseConfig({});

  expect({ restore: config.restoreFleetOnRestart, removed: config.removedKeys }).toStrictEqual({
    restore: true,
    removed: [],
  });
});

test('it reads restoreFleetOnRestart set to false', () => {
  expect(parseConfig({ restoreFleetOnRestart: false }).restoreFleetOnRestart).toBe(false);
});

test('it loads a config that still sets resumeInterruptedTurns and reports the key without its value', () => {
  const config = parseConfig({ resumeInterruptedTurns: true, leader: 'ctrl-a' });

  expect({
    removed: config.removedKeys,
    restore: config.restoreFleetOnRestart,
    leader: config.leader,
  }).toStrictEqual({
    removed: ['resumeInterruptedTurns'],
    restore: true,
    leader: { code: 1, label: '^A' },
  });
});
