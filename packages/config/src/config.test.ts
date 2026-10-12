import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHarnessPlugins } from '@atc/test-utils/build-stub-harness-plugins';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { loadConfig, parseConfig, renderDefaultConfig } from './config';

function setupTest() {
  const tmp = setupTempDir('atc-config-');

  return { dir: tmp.dir };
}

test('#parseConfig leaves every target unusable, local included, and grants no principal a target when the root is not an object', () => {
  expect(
    parseConfig(buildStubHarnessPlugins(), null, '/home/u/.config/atc/config.json'),
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
  expect(parseConfig(buildStubHarnessPlugins(), raw, '/c.json').targetErrors).toStrictEqual([
    { scope: 'config', problem: 'config_malformed', path: '/c.json', detail },
  ]);
});

test('#parseConfig falls back field by field when a field is wrong-typed instead of failing the whole file', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {
    leader: 3,
    restoreFleetOnRestart: 'no',
    dirs: 7,
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
  expect(parseConfig(buildStubHarnessPlugins(), { leader: 'ctrl-a' }).leader).toStrictEqual({
    code: 1,
    label: '^A',
  });
});

test('#parseConfig falls back to the default leader key for an unknown one', () => {
  expect(parseConfig(buildStubHarnessPlugins(), { leader: 'ctrl-nope' }).leader).toStrictEqual({
    code: 0,
    label: '^Space',
  });
});

test('#parseConfig leaves every target unusable and names the migrate command for a config that sets old agent keys', () => {
  const config = parseConfig(
    buildStubHarnessPlugins(),
    {
      claudeBin: '/opt/claude',
      claudeArgs: ['--verbose'],
      gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } },
    },
    '/c.json',
  );

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
          "config.json uses the old agent keys (claudeBin, claudeArgs, gateways); run 'atc config migrate' to move them into agents",
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
  ['claudeBin', 'claude'],
  ['claudeArgs', []],
  ['claudeAuth', {}],
  ['grokBin', 'grok'],
  ['grokArgs', []],
  ['codexBin', 'codex'],
  ['codexArgs', []],
  ['gateways', {}],
])('#parseConfig refuses the old agent key %s, whatever its value', (key, value) => {
  expect(
    parseConfig(buildStubHarnessPlugins(), { [key]: value }, '/c.json').targetErrors,
  ).toStrictEqual([
    {
      scope: 'config',
      problem: 'config_malformed',
      path: '/c.json',
      detail: `config.json uses the old agent keys (${key}); run 'atc config migrate' to move them into agents`,
    },
  ]);
});

test('#parseConfig collects the configured hooks map', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {
    hooks: { SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }] },
  });

  expect(config.hooks).toStrictEqual({
    SessionAttached: [{ command: 'ork focus', dir: '/w', timeout: 2000 }],
  });
});

test('#parseConfig collects the configured directory roots, expanding a leading tilde to the home', () => {
  const config = parseConfig(
    buildStubHarnessPlugins(),
    { dirs: { roots: ['~/projects/', '/srv/work', 7, ''] } },
    '/c.json',
    '/home/someone',
  );

  expect(config.dirs).toStrictEqual({ roots: ['/home/someone/projects', '/srv/work'] });
});

test('#parseConfig expands a leading tilde in a hook dir to the home', () => {
  const config = parseConfig(
    buildStubHarnessPlugins(),
    { hooks: { SessionAttached: [{ command: 'ork focus', dir: '~/w' }] } },
    '/c.json',
    '/home/someone',
  );

  expect(config.hooks).toStrictEqual({
    SessionAttached: [{ command: 'ork focus', dir: '/home/someone/w' }],
  });
});

test('#parseConfig reads the targets and default target a config sets', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {
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
  const config = parseConfig(buildStubHarnessPlugins(), {
    principals: { 'client-a': { targets: ['local'] } },
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
  const config = parseConfig(buildStubHarnessPlugins(), {
    agents: { claude: { bin: 'my-claude' } },
    targets: ['local'],
  });

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

  expect(parseConfig(buildStubHarnessPlugins(), written)).toStrictEqual({
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

test('#parseConfig gives a file with no agent keys at all the three built-in agents and no old keys', () => {
  const config = parseConfig(buildStubHarnessPlugins(), { leader: 'ctrl-a' });

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
  const config = parseConfig(buildStubHarnessPlugins(), {
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
  const config = parseConfig(buildStubHarnessPlugins(), { agents: { codex: {}, claude: {} } });

  expect(config.defaultAgent).toBe('claude');
});

test('#parseConfig keeps reporting claude as the default agent for an empty registry', () => {
  const config = parseConfig(buildStubHarnessPlugins(), { agents: {} });

  expect(config).toStrictEqual({
    agents: [],
    agentErrors: [],
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
  const config = parseConfig(buildStubHarnessPlugins(), { agents: [] });

  expect(config).toStrictEqual({
    agents: [],
    agentErrors: ['agents must be an object of agent entries'],
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
  const config = parseConfig(buildStubHarnessPlugins(), { agents: {}, claudeArgs: [] }, '/c.json');

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
    buildStubHarnessPlugins(),
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
  const config = parseConfig(buildStubHarnessPlugins(), {});

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
  expect(
    parseConfig(buildStubHarnessPlugins(), { restoreFleetOnRestart: false }).restoreFleetOnRestart,
  ).toBe(false);
});

test('#parseConfig loads a config that still sets resumeInterruptedTurns and reports the key without its value', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {
    resumeInterruptedTurns: true,
    leader: 'ctrl-a',
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

  loadConfig(buildStubHarnessPlugins(), file, join(ctx.dir, 'home'), join(ctx.dir, 'state'));

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

test('#loadConfig leaves only the config file in its directory after it writes the default config', () => {
  const ctx = setupTest();

  loadConfig(
    buildStubHarnessPlugins(),
    join(ctx.dir, 'atc', 'config.json'),
    join(ctx.dir, 'home'),
    join(ctx.dir, 'state'),
  );

  expect(readdirSync(join(ctx.dir, 'atc'))).toStrictEqual(['config.json']);
});

test('#loadConfig returns the defaults when the file is missing', () => {
  const ctx = setupTest();

  expect(
    loadConfig(
      buildStubHarnessPlugins(),
      join(ctx.dir, 'config.json'),
      join(ctx.dir, 'home'),
      join(ctx.dir, 'state'),
    ),
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

  expect(
    loadConfig(buildStubHarnessPlugins(), file, join(ctx.dir, 'home'), join(ctx.dir, 'state')),
  ).toStrictEqual({
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

  loadConfig(buildStubHarnessPlugins(), join(ctx.dir, 'config.json'), join(ctx.dir, 'home'), state);

  expect(readdirSync(state)).toBeEmpty();
});

test('#loadConfig never overwrites an existing file it cannot use', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  writeFileSync(file, '{ "agents": ');
  loadConfig(buildStubHarnessPlugins(), file, join(ctx.dir, 'home'), join(ctx.dir, 'state'));

  expect(readFileSync(file, 'utf8')).toBe('{ "agents": ');
});

test('#loadConfig leaves every target unusable when the file cannot be read', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'config.json');

  mkdirSync(file);

  expect(
    loadConfig(buildStubHarnessPlugins(), file, join(ctx.dir, 'home'), join(ctx.dir, 'state')),
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

  expect(
    loadConfig(buildStubHarnessPlugins(), file, join(ctx.dir, 'home'), join(ctx.dir, 'state')),
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
