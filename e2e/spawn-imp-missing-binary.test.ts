import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { LocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';
import { buildMockAgentAdapter, createStubEchoClaude, getRecord } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A real daemon with the local target and an imp target `box` over a stub
// imp port. Its claude agent names a binary missing from the daemon's
// machine, and the stand-in agent runs inside the guest.
async function setupTest() {
  const port = createStubImpPort();

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-imp-missing-',
    options: (paths) => {
      const fakeClaude = createStubEchoClaude(paths.dir);

      return {
        adapter: buildMockAgentAdapter({
          profile: {
            label: 'Claude',
            kind: 'claude',
            bin: join(paths.dir, 'missing', 'claude'),
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
            provider: new LocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: new ImpProvider(
              port,
              { guestDir: join(paths.dir, 'g') },
              { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
            ),
          },
        ],
        defaultTarget: LOCAL_TARGET.id,
      };
    },
  });

  return { client: daemon.client, dir: daemon.dir };
}

test('it lists an agent whose binary is missing here as spawnable only on the imp target', async () => {
  const ctx = await setupTest();
  const listed = await ctx.client.sendRequest('agents.list');

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
      },
    },
  ]);
});

test('it lists the imp target as remote and the local target as not', async () => {
  const ctx = await setupTest();
  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['targets']).toMatchObject([
    { id: 'local', remote: false },
    { id: 'box', remote: true },
  ]);
});

test('it spawns an agent whose binary is missing here on the imp target', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
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
  const ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    target: 'local',
  });

  await Promise.allSettled([spawn]);

  const listed = await ctx.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'claude' is registered but not installed on this host",
  });

  expect(listed).toStrictEqual({ sessions: [] });
});
