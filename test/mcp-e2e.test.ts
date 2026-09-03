import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { isRecord } from '../src/shared/report';
import { waitFor } from './wait-for';

const repo = dirname(import.meta.dir);

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

interface MCPContext {
  readonly home: string;
  readonly sendRPC: (msg: Readonly<Record<string, unknown>>) => void;
  readonly waitForResponse: (id: number) => Promise<Record<string, unknown>>;
}

function setupMCP(extraConfig: Readonly<Record<string, unknown>> = {}): MCPContext {
  const home = mkdtempSync(join(tmpdir(), 'atc-mcp-'));

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');
  const fakeGrok = join(home, 'fake-grok');
  const hookReport = `"${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report`;

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${hookReport}
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    fakeGrok,
    `#!/usr/bin/env bash
echo "FAKE_GROK_UP args: $@"
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${hookReport}
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: fakeGrok,
      grokArgs: [],
      ...extraConfig,
    }),
  );

  const proc: Subprocess<'pipe', 'pipe', 'ignore'> = Bun.spawn(
    [process.execPath, join(repo, 'src', 'cli.ts'), 'mcp'],
    {
      env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home, PATH: '/usr/sbin:/usr/bin:/bin' }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );

  const responses = new Map<number, Record<string, unknown>>();

  let buffer = '';

  void (async () => {
    const decoder = new TextDecoder('utf-8');

    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(line);

          if (isRecord(parsed) && typeof parsed['id'] === 'number') {
            responses.set(parsed['id'], parsed);
          }
        } catch {}
      }
    }
  })();

  onTestFinished(() => {
    proc.kill();

    try {
      const pid = Number(readFileSync(join(home, 'atc-daemon.pid'), 'utf8'));

      if (Number.isInteger(pid) && pid > 1) {
        process.kill(pid, 'SIGTERM');
      }
    } catch {}

    rmSync(home, { recursive: true, force: true });
  });

  return {
    home,
    sendRPC(msg) {
      void proc.stdin.write(`${JSON.stringify(msg)}\n`);
      void proc.stdin.flush();
    },
    async waitForResponse(id: number) {
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        const found = responses.get(id);

        if (found !== undefined) {
          return found;
        }

        await Bun.sleep(20);
      }

      throw new Error(`no response for rpc ${id}`);
    },
  };
}

function getResult(response: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = response['result'];

  if (!isRecord(result)) {
    throw new TypeError('response has no result object');
  }

  return result;
}

function getText(result: Readonly<Record<string, unknown>>): string {
  const content = result['content'];

  if (!Array.isArray(content)) {
    throw new TypeError('result has no content array');
  }

  const first: unknown = content.at(0);

  if (!isRecord(first) || typeof first['text'] !== 'string') {
    throw new TypeError('result content has no text');
  }

  return first['text'];
}

test('it initializes and lists the fleet tools', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
  });

  const initResponse = await ctx.waitForResponse(1);

  const init = getResult(initResponse);

  expect(init['protocolVersion']).toBe('2025-06-18');
  expect(init['serverInfo']).toMatchObject({ name: 'atc' });

  ctx.sendRPC({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const listResponse = await ctx.waitForResponse(2);

  const listed = getResult(listResponse);
  const tools = listed['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('tools is not an array');
  }

  const names = tools.filter((t) => isRecord(t)).map((t) => t['name']);

  expect(names).toIncludeAllMembers([
    'atc_session_list',
    'atc_session_spawn',
    'atc_session_input',
    'atc_session_screen',
    'atc_session_update',
    'atc_session_kill',
    'atc_session_ack',
    'atc_resume_command',
    'atc_dirs_list',
  ]);
});

test('it spawns and lists a session through tool calls', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, name: 'mcp-spawned' } },
  });

  const spawnResponse = await ctx.waitForResponse(2);

  const spawned = getResult(spawnResponse);

  expect(spawned['isError']).toBeUndefined();
  expect(getText(spawned)).toInclude('"name": "mcp-spawned"');
  expect(getText(spawned)).toInclude('"agent": "claude"');

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'atc_session_list', arguments: {} },
  });

  const listResponse = await ctx.waitForResponse(3);

  const listed = getResult(listResponse);

  expect(getText(listed)).toInclude('mcp-spawned');
});

test('it reads a session screen through a tool call', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home } },
  });

  const spawnResponse = await ctx.waitForResponse(2);

  const spawned: unknown = JSON.parse(getText(getResult(spawnResponse)));

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new TypeError('spawn answer has no session id');
  }

  const session = spawned['id'];
  let rpcID = 3;

  const screen = await waitFor(async () => {
    const id = rpcID++;

    ctx.sendRPC({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'atc_session_screen', arguments: { session } },
    });

    const response = await ctx.waitForResponse(id);

    const result = getResult(response);

    expect(result['isError']).toBeUndefined();
    expect(getText(result)).toInclude('FAKE_CLAUDE_UP');

    return getText(result);
  });

  expect(screen).toStartWith('FAKE_CLAUDE_UP args:');
});

test('it advertises agent on atc_session_spawn as an open string', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const listResponse = await ctx.waitForResponse(2);

  const listed = getResult(listResponse);
  const tools = listed['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('tools is not an array');
  }

  const spawnTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_spawn',
  );

  if (!isRecord(spawnTool) || !isRecord(spawnTool['inputSchema'])) {
    throw new TypeError('atc_session_spawn has no input schema');
  }

  const properties = spawnTool['inputSchema']['properties'];

  if (!isRecord(properties) || !isRecord(properties['agent'])) {
    throw new TypeError('atc_session_spawn schema has no agent field');
  }

  expect(properties['agent']).toStrictEqual({
    type: 'string',
    minLength: 1,
    description: 'Which registered agent id to spawn; defaults to claude',
  });
});

test('it reports an unregistered agent id as a failed tool call', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, agent: 'gemini' } },
  });

  const failResponse = await ctx.waitForResponse(2);

  const failed = getResult(failResponse);

  expect(failed['isError']).toBeTrue();
  expect(getText(failed)).toInclude("unsupported: no adapter for agent 'gemini'");
});

test("it rejects an empty agent id with the daemon's shared-schema message", async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, agent: '' } },
  });

  const failResponse = await ctx.waitForResponse(2);

  const failed = getResult(failResponse);

  expect(failed['isError']).toBeTrue();
  expect(getText(failed)).toInclude('session.spawn agent must be a non-empty agent id');
});

test('it reports a failed tool call with isError instead of crashing', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_kill', arguments: { session: 'nope' } },
  });

  const failResponse = await ctx.waitForResponse(2);

  const failed = getResult(failResponse);

  expect(failed['isError']).toBeTrue();
  expect(getText(failed)).toInclude('no_such_session');

  ctx.sendRPC({ jsonrpc: '2.0', id: 3, method: 'ping' });

  const pong = await ctx.waitForResponse(3);

  expect(pong['result']).toStrictEqual({});
});

test('it answers an unknown rpc method with a json-rpc error', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'bogus/method' });

  const response = await ctx.waitForResponse(1);

  expect(response['error']).toMatchObject({ code: -32_601 });
});

test('it spawns a session under a configured backend id', async () => {
  const ctx = setupMCP({
    gateways: {
      zai: { label: 'GLM (z.ai)', mark: 'z', baseURL: 'https://api.z.ai/api/anthropic' },
    },
  });

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'atc_session_spawn',
      arguments: { cwd: ctx.home, name: 'glm-work', agent: 'zai' },
    },
  });

  const spawnResponse = await ctx.waitForResponse(2);

  const spawned = getResult(spawnResponse);

  expect(spawned['isError']).toBeUndefined();
  expect(getText(spawned)).toInclude('"agent": "zai"');
  expect(getText(spawned)).toInclude('"canEject": true');
});

test('it writes a backend settings file that carries the base URL and no credential', async () => {
  const ctx = setupMCP({
    gateways: {
      zai: {
        label: 'GLM (z.ai)',
        mark: 'z',
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: '/usr/bin/true',
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
      },
    },
  });

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, agent: 'zai' } },
  });

  await ctx.waitForResponse(2);

  const settingsPath = join(ctx.home, '.local', 'state', 'atc', 'hook-settings-zai.json');
  const written: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));

  if (!isRecord(written)) {
    throw new TypeError('settings file is not an object');
  }

  expect(written['env']).toStrictEqual({
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  });

  expect(written['apiKeyHelper']).toBe('/usr/bin/true');
  expect(readFileSync(settingsPath, 'utf8')).not.toInclude('ANTHROPIC_AUTH_TOKEN');
  expect(written['hooks']).toBeDefined();
});
