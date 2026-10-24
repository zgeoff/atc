import { expect, test } from 'bun:test';
import { AGENT_LIST_SCHEMA } from './agent-list';
import type { AgentList } from './agent-list';

test('it accepts an agent list whose agent holds every spawn option', () => {
  const payload: AgentList = {
    daemon: { hostname: 'workbench', platform: 'linux', arch: 'x64', build: 'atc/1.2.3' },
    agents: [
      {
        id: 'claude',
        label: 'Claude Code',
        kind: 'claude',
        installed: true,
        brokerAuth: false,
        brokerRequired: false,
        spawnTargets: ['local'],
        capabilities: {
          spawn: true,
          readTranscript: true,
          message: true,
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
            supported: true,
            values: ['low', 'high'],
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: null,
            available: true,
          },
          pluginDirs: {
            supported: true,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: null,
            available: true,
          },
        },
      },
    ],
    targets: [],
    spawnDefaults: { agent: 'claude', target: null },
    configRevision: 'r-1',
    targetErrors: [],
    sources: [],
  };

  expect(AGENT_LIST_SCHEMA.safeParse(payload).data).toStrictEqual(payload);
});

test('it rejects an agent list whose agent holds no plugin folder option', () => {
  const result = AGENT_LIST_SCHEMA.safeParse({
    daemon: { hostname: 'workbench', platform: 'linux', arch: 'x64', build: 'atc/1.2.3' },
    agents: [
      {
        id: 'claude',
        label: 'Claude Code',
        kind: 'claude',
        installed: true,
        brokerAuth: false,
        brokerRequired: false,
        spawnTargets: ['local'],
        capabilities: {
          spawn: true,
          readTranscript: true,
          message: true,
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
            supported: true,
            values: ['low', 'high'],
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: null,
            available: true,
          },
        },
      },
    ],
    targets: [],
    spawnDefaults: { agent: 'claude', target: null },
    configRevision: 'r-1',
    targetErrors: [],
    sources: [],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['agents', 0, 'spawnOptions', 'pluginDirs'],
  });
});
