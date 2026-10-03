import { expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { CodexAdapter } from '../agents/codex-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
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

  const claude = new ClaudeAdapter(config);

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: claude,
    adapters: [
      claude,
      new GrokAdapter(config),
      new CodexAdapter(config),
      ...config.gateways.map((gateway) => new GatewayAdapter(gateway, config)),
    ],
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
        capabilities: {
          spawn: true,
          readTranscript: true,
          message: true,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
      },
      {
        id: 'grok',
        label: 'Grok',
        kind: 'grok',
        installed: true,
        capabilities: {
          spawn: true,
          readTranscript: false,
          message: false,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
      },
      {
        id: 'codex',
        label: 'Codex',
        kind: 'codex',
        installed: false,
        capabilities: {
          spawn: false,
          readTranscript: false,
          message: false,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
      },
      {
        id: 'zai',
        label: 'GLM (z.ai)',
        kind: 'gateway',
        installed: true,
        capabilities: {
          spawn: true,
          readTranscript: true,
          message: true,
          attach: true,
          screen: true,
          input: true,
        },
        models: { opus: 'glm-4.6' },
      },
    ],
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
