import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { startTestDaemon } from '../test-utils/start-test-daemon';

test('it lists an agent atc has no code for with the kind and label its adapter declares', async () => {
  const acme = buildMockAgentAdapter({
    id: 'acme',
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
  });

  await using daemon = await startTestDaemon({
    options: () => ({ adapter: acme, adapters: [acme] }),
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['agents']).toStrictEqual([
    {
      id: 'acme',
      label: 'Acme Agent',
      kind: 'acme-cli',
      installed: true,
      brokerAuth: false,
      brokerRequired: false,
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
    },
  ]);
});

test('it lists an adapter without a profile under its own id as its kind', async () => {
  const bare = buildMockAgentAdapter({ id: 'bare' });

  await using daemon = await startTestDaemon({
    options: () => ({ adapter: bare, adapters: [bare] }),
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['agents']).toStrictEqual([
    {
      id: 'bare',
      label: 'bare',
      kind: 'bare',
      installed: false,
      brokerAuth: false,
      brokerRequired: false,
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
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
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
    },
  ]);
});

test('it spawns a session under an agent atc has no code for', async () => {
  const acme = buildMockAgentAdapter({
    id: 'acme',
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
  });

  await using daemon = await startTestDaemon({
    options: () => ({ adapter: acme, adapters: [acme] }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'acme',
    model: 'acme-large',
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'acme', alive: true });
});
