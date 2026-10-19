import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from '@atc/test-utils';
import { buildAgentList } from './build-agent-list';

test.each([
  ['a target on the daemon machine', [{ id: 'local', remote: false, brokerAuth: false }], true],
  ['only a remote target', [{ id: 'box', remote: true, brokerAuth: false }], false],
])('it lists plugin folders as available with %s: %p', (_label, targets, available) => {
  const adapter = buildMockAgentAdapter({
    id: 'claude',
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        pluginDirs: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: 'applied',
          note: null,
        },
      },
    },
  });

  const [listed] = buildAgentList([adapter], () => true, targets);

  expect(listed?.spawnOptions.pluginDirs).toStrictEqual({
    supported: true,
    values: null,
    examples: [],
    default: null,
    backendEffect: 'applied',
    note: null,
    available,
  });
});

test.each([
  [
    'a target on the daemon machine and a remote one',
    [
      { id: 'local', remote: false, brokerAuth: false },
      { id: 'box', remote: true, brokerAuth: false },
    ],
    ['local'],
  ],
  ['only a remote target', [{ id: 'box', remote: true, brokerAuth: false }], []],
])(
  'it lists an agent whose config loads plugin folders as spawnable on no remote target, with %s',
  (_label, targets, spawnTargets) => {
    const adapter = buildMockAgentAdapter({
      id: 'claude',
      profile: {
        label: 'Claude',
        kind: 'claude',
        bin: 'claude',
        models: null,
        spawnOptions: {
          model: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
          effort: {
            supported: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
          },
        },
        pluginDirs: ['/opt/plugins/shared'],
      },
    });

    const [listed] = buildAgentList([adapter], () => true, targets);

    expect(listed).toMatchObject({
      spawnTargets,
      capabilities: { spawn: spawnTargets.length > 0 },
    });
  },
);

test('it lists an agent whose binary is missing as spawnable only on a remote target', () => {
  const adapter = buildMockAgentAdapter({
    id: 'claude',
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: 'applied',
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
  });

  expect(
    buildAgentList([adapter], () => false, [
      { id: 'local', remote: false, brokerAuth: false },
      { id: 'box', remote: true, brokerAuth: false },
    ]),
  ).toStrictEqual([
    {
      id: 'claude',
      label: 'Claude',
      kind: 'claude',
      installed: false,
      brokerAuth: false,
      brokerRequired: false,
      spawnTargets: ['box'],
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: 'applied',
          note: null,
          available: true,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        pluginDirs: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
      },
    },
  ]);
});

test('it lists an agent that takes the broker credential as spawnable once a target reaches the broker', () => {
  const adapter = buildMockAgentAdapter({
    id: 'glm',
    profile: {
      label: 'GLM',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    findAuthSelection: () => ({
      brokerRequired: true,
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'], placeholderEnv: {} },
      },
      profiles: new Map(),
    }),
  });

  expect(
    buildAgentList([adapter], () => true, [{ id: 'box', remote: true, brokerAuth: true }]),
  ).toStrictEqual([
    {
      id: 'glm',
      label: 'GLM',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: true,
      spawnTargets: ['box'],
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        pluginDirs: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
      },
    },
  ]);
});

test('it lists an agent that takes the broker credential as not spawnable when no target reaches the broker', () => {
  const adapter = buildMockAgentAdapter({
    id: 'glm',
    profile: {
      label: 'GLM',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    findAuthSelection: () => ({
      brokerRequired: true,
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'], placeholderEnv: {} },
      },
      profiles: new Map(),
    }),
  });

  expect(
    buildAgentList([adapter], () => true, [{ id: 'local', remote: false, brokerAuth: false }]),
  ).toStrictEqual([
    {
      id: 'glm',
      label: 'GLM',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: true,
      spawnTargets: [],
      capabilities: {
        spawn: false,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        pluginDirs: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
      },
    },
  ]);
});

test('it lists an agent that takes no broker credential as spawnable when no target reaches the broker', () => {
  const adapter = buildMockAgentAdapter({
    id: 'plain',
    profile: {
      label: 'Plain',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
  });

  expect(
    buildAgentList([adapter], () => true, [{ id: 'local', remote: false, brokerAuth: false }]),
  ).toStrictEqual([
    {
      id: 'plain',
      label: 'Plain',
      kind: 'claude',
      installed: true,
      brokerAuth: false,
      brokerRequired: false,
      spawnTargets: ['local'],
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        pluginDirs: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
      },
    },
  ]);
});

test('it lists an agent that takes the broker credential only where a broker is as spawnable when no target reaches one', () => {
  const adapter = buildMockAgentAdapter({
    id: 'claude',
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'claude',
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    findAuthSelection: () => ({
      brokerRequired: false,
      gateway: {
        id: 'claude',
        baseURL: 'https://api.anthropic.com',
        auth: {
          profiles: ['claude'],
          placeholderEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        },
      },
      profiles: new Map(),
    }),
  });

  expect(
    buildAgentList([adapter], () => true, [{ id: 'local', remote: false, brokerAuth: false }]),
  ).toStrictEqual([
    {
      id: 'claude',
      label: 'Claude',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: false,
      spawnTargets: ['local'],
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: true,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: true,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
        pluginDirs: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
          available: false,
        },
      },
    },
  ]);
});
