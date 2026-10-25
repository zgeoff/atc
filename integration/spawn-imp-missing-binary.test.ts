import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@atc/config';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';
import { buildMockAgentAdapter, createStubEchoClaude, getRecord } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it lists an agent whose binary is missing here as spawnable only on the imp target', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-missing-',
    options: (paths) => {
      const fakeClaude = createStubEchoClaude(paths.directory);

      return {
        adapter: buildMockAgentAdapter({
          profile: {
            label: 'Claude',
            kind: 'claude',
            bin: join(paths.directory, 'missing', 'claude'),
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
          planSpawn: () => ({ bin: fakeClaude, args: [] }),
        }),
        targets: [
          {
            id: LOCAL_TARGET.id,
            kind: LOCAL_TARGET.provider,
            options: LOCAL_TARGET.options,
            identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
            provider: createLocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: createImpProvider(
              createStubImpPort(),
              { guestDir: join(paths.directory, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
        ],
        defaultTarget: LOCAL_TARGET.id,
      };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['agents']).toStrictEqual([
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

test('it lists the imp target as remote and the local target as not', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-missing-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        {
          id: LOCAL_TARGET.id,
          kind: LOCAL_TARGET.provider,
          options: LOCAL_TARGET.options,
          identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
          provider: createLocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: createImpProvider(
            createStubImpPort(),
            { guestDir: join(paths.directory, 'g') },
            { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
          ),
        },
      ],
      defaultTarget: LOCAL_TARGET.id,
    }),
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['targets']).toMatchObject([
    { id: 'local', remote: false },
    { id: 'box', remote: true },
  ]);
});

test('it spawns an agent whose binary is missing here on the imp target', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-missing-',
    options: (paths) => {
      const fakeClaude = createStubEchoClaude(paths.directory);

      return {
        adapter: buildMockAgentAdapter({
          profile: {
            label: 'Claude',
            kind: 'claude',
            bin: join(paths.directory, 'missing', 'claude'),
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
          planSpawn: () => ({ bin: fakeClaude, args: [] }),
        }),
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: createImpProvider(
              createStubImpPort(),
              { guestDir: join(paths.directory, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
        ],
        defaultTarget: 'box',
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    target: 'box',
  });

  expect(getRecord(spawned, 'session')).toMatchObject({
    agent: 'claude',
    locator: { targetID: 'box' },
    state: 'running',
  });
});

test('it refuses an agent whose binary is missing here on the local target', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-missing-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: join(paths.directory, 'missing', 'claude'),
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
      }),
      targets: [
        {
          id: LOCAL_TARGET.id,
          kind: LOCAL_TARGET.provider,
          options: LOCAL_TARGET.options,
          identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
          provider: createLocalPTYProvider(),
        },
      ],
      defaultTarget: LOCAL_TARGET.id,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    target: 'local',
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'claude' is registered but not installed on this host",
  });

  expect(listed).toStrictEqual({ sessions: [] });
});
