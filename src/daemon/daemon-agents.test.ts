import { expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { isRecord } from '../shared/report';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';

// agents.list through the real daemon, with the real adapters built from a
// config that registers a gateway carrying secrets and points codex at a
// binary that does not exist.
async function setupTest() {
  const tmp = setupTempDir('atc-agents-');
  const sockPath = join(tmp.dir, 'daemon.sock');

  const config = parseConfig({
    claudeBin: 'sh',
    grokBin: 'sh',
    codexBin: join(tmp.dir, 'missing', 'codex'),
    gateways: {
      zai: {
        label: 'GLM (z.ai)',
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read op://vault/zai/key',
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
          ANTHROPIC_AUTH_TOKEN: 'sk-zai-secret',
          API_TIMEOUT_MS: '600000',
        },
      },
    },
  });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: buildAgentAdapters(config),
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

test('it lists each registered agent with what it can do and the host it runs on', async () => {
  await using daemon = await setupTest();

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed).toStrictEqual({
    daemon: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      build: 'atc/test-build',
    },
    agents: [
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
            available: true,
            values: null,
            examples: expect.toBeArrayOfSize(8),
            default: null,
            backendEffect: 'applied',
            note: 'An alias or a full model name, passed as --model.',
          },
          effort: {
            supported: true,
            available: true,
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: 'Passed as --effort. Which levels a session honours depends on its model.',
          },
        },
      },
      {
        id: 'grok',
        label: 'Grok',
        kind: 'grok',
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
            supported: false,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: 'atc does not pass this option to Grok.',
          },
          effort: {
            supported: false,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: 'atc does not pass this option to Grok.',
          },
        },
      },
      {
        id: 'codex',
        label: 'Codex',
        kind: 'codex',
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
            supported: true,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: 'applied',
            note: 'A model name, passed as -m.',
          },
          effort: {
            supported: false,
            available: false,
            values: null,
            examples: [],
            default: null,
            backendEffect: null,
            note: 'Codex documents its reasoning effort levels as depending on the model, with no closed list, so atc does not pass one.',
          },
        },
      },
      {
        id: 'zai',
        label: 'GLM (z.ai)',
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
        models: { opus: 'glm-4.6' },
        spawnOptions: {
          model: {
            supported: true,
            available: true,
            values: null,
            examples: [{ value: 'opus', resolvesTo: 'glm-4.6' }],
            default: null,
            backendEffect: 'applied',
            note: "A tier alias the gateway's env maps, or a model name the provider accepts, passed as --model.",
          },
          effort: {
            supported: true,
            available: true,
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
            examples: [],
            default: null,
            backendEffect: 'unverified',
            note: "Passed as --effort; the gateway's provider may ignore it.",
          },
        },
      },
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        available: true,
        default: true,
        capabilities: {
          spawn: true,
          attach: true,
          input: true,
          resize: true,
          kill: true,
          transfer: true,
          run: true,
          headless: true,
          suspend: false,
          destroy: false,
        },
        brokerAuth: false,
      },
    ],
    spawnDefaults: { agent: 'claude', target: 'local' },
    configRevision: expect.stringMatching(/^[\da-f]{16}$/),
    targetErrors: [],
    sources: [],
  });
});

test("it keeps a gateway's env values, helper, and base URL out of the agent list", async () => {
  await using daemon = await setupTest();

  const answer = await daemon.client.sendRequest('agents.list');

  const listed = JSON.stringify(answer);

  expect(listed).not.toInclude('sk-zai-secret');
  expect(listed).not.toInclude('ANTHROPIC_AUTH_TOKEN');
  expect(listed).not.toInclude('600000');
  expect(listed).not.toInclude('op read');
  expect(listed).not.toInclude('api.z.ai');
});

test('it refuses a registered agent whose binary is missing before spawning anything', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'codex' });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'codex' is registered but not installed on this host",
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it neither lists nor spawns an agent id the daemon never registered', async () => {
  await using daemon = await setupTest();

  const agents = await daemon.client.sendRequest('agents.list');

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'gemini' });

  expect(JSON.stringify(agents)).not.toInclude('gemini');
  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a model shaped like a flag before spawning anything', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    model: '--dangerously-skip-permissions',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a gateway effort outside the levels the CLI accepts', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'zai',
    effort: 'ultra',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses an option the agent takes no value for', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'grok',
    model: 'grok-4',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'grok' takes no model",
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a model that is not a string', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', model: 7 });

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: 'session.spawn model must be a string',
  });
});

test('it lists a spawned session with the model it was spawned with', async () => {
  await using daemon = await setupTest();

  const ok = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'zai',
    model: 'opus',
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'zai', model: 'opus' });

  const list = await daemon.client.sendRequest('session.list');

  expect(list).toMatchObject({ sessions: [{ agent: 'zai', model: 'opus' }] });
});

test('it lists a spawned session without a model key when it runs the default', async () => {
  await using daemon = await setupTest();

  await daemon.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  const list = await daemon.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions).toBeArrayOfSize(1);
  expect(sessions[0]).toBeObject();

  if (!isRecord(sessions[0])) {
    throw new TypeError('session is not a record');
  }

  expect(Object.keys(sessions[0])).not.toInclude('model');
});
