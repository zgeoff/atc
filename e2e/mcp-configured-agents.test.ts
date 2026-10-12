import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core/is-record';
import { startMCPStdio } from '@atc/test-utils/start-mcp-stdio';
import invariant from 'tiny-invariant';
import { setupMCPHome } from '../packages/app/src/test-utils/setup-mcp-home';

function setupTest() {
  const mcpHome = setupMCPHome();

  return {
    home: mcpHome.home,
    claudeBin: mcpHome.claudeBin,
    grokBin: mcpHome.grokBin,
  };
}

test('it advertises the spawn agent as an open string listing the registered agents', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('tools/list');

  const result = response['result'];

  invariant(isRecord(result) && Array.isArray(result['tools']), 'tools/list returned no tools');

  const spawnTool: unknown = result['tools'].find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  invariant(
    isRecord(spawnTool) && isRecord(spawnTool['inputSchema']),
    'the spawn tool has no input schema',
  );

  const properties = spawnTool['inputSchema']['properties'];

  invariant(isRecord(properties), 'the spawn tool schema has no properties');

  expect(properties['agent']).toStrictEqual({
    type: 'string',
    minLength: 1,
    description:
      'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_spawn_options_get returns the current list.',
  });
});

test('it refuses through a spawn a registered agent that is not installed', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const failed = await mcp.sendToolCall('atc_session_spawn', { cwd: ctx.home, agent: 'codex' });

  expect(failed).toStrictEqual({
    isError: true,
    text: "unsupported: agent 'codex' is registered but not installed on this host",
    structured: undefined,
  });
});

test('it spawns a session under a configured backend id', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },
        codex: { kind: 'codex' },
        zai: {
          kind: 'claude',
          label: 'GLM (z.ai)',
          mark: 'z',
          baseURL: 'https://api.z.ai/api/anthropic',
          bin: ctx.claudeBin,
        },
      },
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });

  const spawned = await mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    name: 'glm-work',
    agent: 'zai',
  });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"agent": "zai"');
  expect(spawned.text).toInclude('"canEject": true');
});

test('it writes a backend settings file that carries the base URL and no credential', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },
        codex: { kind: 'codex' },
        zai: {
          kind: 'claude',
          bin: ctx.claudeBin,
          label: 'GLM (z.ai)',
          mark: 'z',
          baseURL: 'https://api.z.ai/api/anthropic',
          apiKeyHelper: '/usr/bin/true',
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
      },
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });

  await mcp.spawnSession({ cwd: ctx.home, agent: 'zai' });

  const written = readFileSync(
    join(ctx.home, '.local', 'state', 'atc', 'hook-settings-zai.json'),
    'utf8',
  );

  expect(written).not.toInclude('ANTHROPIC_AUTH_TOKEN');

  expect(JSON.parse(written)).toStrictEqual({
    apiKeyHelper: '/usr/bin/true',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(" hook-report --agent 'zai'"),
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(" hook-report --agent 'zai'"),
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(" hook-report --agent 'zai'"),
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(" hook-report --agent 'zai'"),
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: expect.toEndWith(" hook-report --agent 'zai'"),
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: expect.toEndWith(" statusline --agent 'zai'"),
      padding: 0,
    },
  });
});
