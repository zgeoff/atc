import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';
import type { RestoreSettled } from './restore-fleet';

/**
 * A temp directory holding a fake Claude that records each start in
 * `marker`, and the two targets a daemon runs on: `local`, and the imp
 * target `box` over a stub imp port. `settles` collects the fleet restores
 * a daemon reports to the `onRestoreSettled` recorder.
 */
function setupTest() {
  const tmp = setupTempDir('atc-auth-gateway-');
  const port = createStubImpPort();
  const settles: RestoreSettled[] = [];

  const box = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  registerTestCleanup(() => {
    box.dispose();
  });

  return {
    dir: tmp.dir,
    port,
    settles,
    fakeClaude: createStubRecordingClaude(tmp.dir),
    marker: join(tmp.dir, 'claude-starts.log'),
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: 'local-pty:test',
        provider: new LocalPTYProvider(),
      },
      { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: box },
    ],
    onRestoreSettled: (settled: RestoreSettled) => {
      settles.push(settled);
    },
  };
}

test('it refuses a local spawn of a gateway with auth and starts no harness', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it refuses an imp spawn of a gateway with auth before touching impd', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  await Promise.allSettled([spawn]);

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
  expect(ctx.port.sessionRequests).toStrictEqual([]);
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it starts the harness of a gateway without auth on a local spawn', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'zai', target: 'local' });

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();
  });
});

test('it lists a gateway with auth as able to spawn, since a target with a broker binding can start it', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  const answer = await daemon.client.sendRequest('agents.list');

  expect(answer['agents']).toStrictEqual([
    {
      id: 'claude',
      label: 'Claude',
      kind: 'claude',
      installed: true,
      brokerAuth: false,
      brokerRequired: false,
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
          examples: [
            { value: 'best', resolvesTo: null },
            { value: 'fable', resolvesTo: null },
            { value: 'opus', resolvesTo: null },
            { value: 'sonnet', resolvesTo: null },
            { value: 'haiku', resolvesTo: null },
            { value: 'opus[1m]', resolvesTo: null },
            { value: 'sonnet[1m]', resolvesTo: null },
            { value: 'opusplan', resolvesTo: null },
          ],
          default: null,
          backendEffect: 'applied',
          note: 'An alias or a full model name, passed as --model.',
          available: true,
        },
        effort: {
          supported: true,
          values: ['low', 'medium', 'high', 'xhigh', 'max'],
          examples: [],
          default: null,
          backendEffect: 'applied',
          note: 'Passed as --effort. Which levels a session honours depends on its model.',
          available: true,
        },
      },
    },
    {
      id: 'glm',
      label: 'glm',
      kind: 'gateway',
      installed: true,
      brokerAuth: true,
      brokerRequired: true,
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
          note: "A tier alias the gateway's env maps, or a model name the provider accepts, passed as --model.",
          available: true,
        },
        effort: {
          supported: true,
          values: ['low', 'medium', 'high', 'xhigh', 'max'],
          examples: [],
          default: null,
          backendEffect: 'unverified',
          note: "Passed as --effort; the gateway's provider may ignore it.",
          available: true,
        },
      },
    },
    {
      id: 'zai',
      label: 'zai',
      kind: 'gateway',
      installed: true,
      brokerAuth: false,
      brokerRequired: false,
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
          note: "A tier alias the gateway's env maps, or a model name the provider accepts, passed as --model.",
          available: true,
        },
        effort: {
          supported: true,
          values: ['low', 'medium', 'high', 'xhigh', 'max'],
          examples: [],
          default: null,
          backendEffect: 'unverified',
          note: "Passed as --effort; the gateway's provider may ignore it.",
          available: true,
        },
      },
    },
  ]);
});

test('it refuses a local spawn that resumes a session of a gateway with auth and starts no harness', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it refuses to adopt a restored local session of a gateway with auth and starts no harness', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  // A transcript that exists makes the session resumable.
  const transcriptPath = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcriptPath, '');

  // The stored fleet is read when the daemon starts, so it is written while
  // the daemon is stopped.
  await daemon.stop();

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  await store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s1'),
      cwd: ctx.dir,
      agent: 'glm',
      exited: true,
      transcriptPath,
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  ]);

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = daemon.client.sendRequest('session.adopt', { session: 's1' });

  await Promise.allSettled([adopt]);

  expect(adopt).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it restores a local session of a gateway with auth without starting its harness', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            claude: { bin: ctx.fakeClaude },
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
            zai: { kind: 'claude', bin: ctx.fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'local',
      onRestoreSettled: ctx.onRestoreSettled,
    }),
  });

  // A transcript that exists makes the session resumable.
  const transcriptPath = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcriptPath, '');

  // The stored fleet is read when the daemon starts, so it is written while
  // the daemon is stopped.
  await daemon.stop();

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  await store.writeFleet([
    buildMockFleetEntry({
      cwd: ctx.dir,
      agent: 'glm',
      target: 'local',
      targetIdentity: 'local-pty:test',
      transcriptPath,
    }),
  ]);

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.settles).toHaveLength(1);
  });

  expect(ctx.settles).toStrictEqual([{ restored: 1, outcome: 'finished' }]);
  expect(existsSync(ctx.marker)).toBeFalse();
});
