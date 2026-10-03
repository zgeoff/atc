import { expect, test } from 'bun:test';
import type { AgentAdapter } from '../agents/agent-adapter';
import { buildAgentList } from './build-agent-list';

test('it lists an agent that takes the broker credential as spawnable once a target reaches the broker', () => {
  const adapter: AgentAdapter = {
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
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
    planSpawn: () => ({ bin: 'claude', args: [] }),
    findAuthSelection: () => ({
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'], placeholderEnv: {} },
      },
      profiles: new Map(),
    }),
  };

  const [entry] = buildAgentList([adapter], () => true, true);

  expect(entry).toMatchObject({ brokerAuth: true, capabilities: { spawn: true } });
});

test('it lists an agent that takes the broker credential as not spawnable when no target reaches the broker', () => {
  const adapter: AgentAdapter = {
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
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
    planSpawn: () => ({ bin: 'claude', args: [] }),
    findAuthSelection: () => ({
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'], placeholderEnv: {} },
      },
      profiles: new Map(),
    }),
  };

  const [entry] = buildAgentList([adapter], () => true, false);

  expect(entry).toMatchObject({
    brokerAuth: true,
    capabilities: { spawn: false },
    spawnOptions: { model: { available: false } },
  });
});

test('it lists an agent that takes no broker credential as spawnable when no target reaches the broker', () => {
  const adapter: AgentAdapter = {
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
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
    planSpawn: () => ({ bin: 'claude', args: [] }),
  };

  const [entry] = buildAgentList([adapter], () => true, false);

  expect(entry).toMatchObject({ brokerAuth: false, capabilities: { spawn: true } });
});
