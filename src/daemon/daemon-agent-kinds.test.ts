import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from './daemon';

// A real daemon whose registry holds only adapters no atc source knows: one
// that declares its own profile and one stand-in without a profile.
async function setupTest() {
  const tmp = setupTempDir('atc-agent-kinds-');
  const sockPath = join(tmp.dir, 'daemon.sock');

  const acme: AgentAdapter = {
    id: 'acme',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    profile: {
      label: 'Acme Agent',
      kind: 'acme-cli',
      bin: 'sleep',
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
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const standIn: AgentAdapter = {
    id: 'bare',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: acme,
    adapters: [acme, standIn],
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it lists an agent atc has no code for with the kind and label its adapter declares', async () => {
  await using daemon = await setupTest();

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['agents']).toContainEqual({
    id: 'acme',
    label: 'Acme Agent',
    kind: 'acme-cli',
    installed: true,
    brokerAuth: false,
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
        available: true,
        values: null,
        examples: [],
        default: null,
        backendEffect: 'applied',
        note: null,
      },
      effort: {
        supported: false,
        available: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
      },
    },
  });
});

test('it lists an adapter without a profile under its own id as its kind', async () => {
  await using daemon = await setupTest();

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['agents']).toContainEqual(
    expect.objectContaining({ id: 'bare', label: 'bare', kind: 'bare', installed: false }),
  );
});

test('it spawns a session under an agent atc has no code for', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'acme',
    model: 'acme-large',
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'acme', alive: true });
});
