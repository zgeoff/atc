import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, renderDefaultConfig } from './config';

test('it leaves every target unusable, local included, and grants no principal a target when the root is not an object', () => {
  expect(parseConfig(null, '/home/u/.config/atc/config.json')).toStrictEqual({
    claudeBin: 'claude',
    claudeArgs: [],
    claudeAuth: null,
    claudeAuthErrors: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    gateways: [],
    gatewayErrors: [],
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
    claudeBin: 'claude',
    claudeArgs: [],
    claudeAuth: null,
    claudeAuthErrors: [],
    grokBin: 'my-grok',
    grokArgs: ['--yolo'],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    gateways: [],
    gatewayErrors: [],
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
  });
});

test('it decodes a configured leader key and falls back to the default for an unknown one', () => {
  expect(parseConfig({ leader: 'ctrl-a' }).leader).toStrictEqual({ code: 1, label: '^A' });
  expect(parseConfig({ leader: 'ctrl-nope' }).leader).toStrictEqual({ code: 0, label: '^Space' });
});

test('it collects the configured gateway map using the parsed claude bin and args', () => {
  const config = parseConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  expect(config.gateways).toStrictEqual([
    {
      id: 'zai',
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
  const config = parseConfig({ claudeBin: 'my-claude', targets: ['local'] });

  expect({
    claudeBin: config.claudeBin,
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

  expect(config).toStrictEqual(parseConfig({}));
  expect(config.targetErrors).toStrictEqual([]);
});

test('it reads the auth profiles a config sets and registers a gateway whose auth selects them', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    gateways: {
      glm: {
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
    gateways: config.gateways,
    gatewayErrors: config.gatewayErrors,
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
          dependencies: [],
        },
      ],
    ]),
    authProfileErrors: [],
    gateways: [
      {
        id: 'glm',
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
    gatewayErrors: [],
  });
});

test('it refuses a gateway whose auth selects a profile the config refused, and reports both', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'raw' },
    },
    gateways: {
      glm: { baseURL: 'https://api.z.ai/api/anthropic', auth: { profiles: ['glm'] } },
    },
  });

  expect({
    authProfileErrors: config.authProfileErrors,
    gateways: config.gateways,
    gatewayErrors: config.gatewayErrors,
  }).toStrictEqual({
    authProfileErrors: ['authProfiles.glm: scheme must be bearer, the one scheme atc binds'],
    gateways: [],
    gatewayErrors: [
      'gateways.glm: profile glm is selected, but authProfiles has no usable profile by that name',
    ],
  });
});
