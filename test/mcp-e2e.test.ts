import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { isRecord } from '../src/shared/report';
import { startLegacyDaemon } from './start-legacy-daemon';
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

interface MCPOptions {
  readonly config?: Readonly<Record<string, unknown>>;

  // A home from an earlier setup, so a second server joins the same daemon.
  readonly home?: string;

  // The session id the server sees itself running inside; absent means a
  // server started outside any session.
  readonly callerSessionID?: string;
}

function setupMCP(options: MCPOptions = {}): MCPContext {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'atc-mcp-'));
  const extraConfig = options.config ?? {};

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');
  const fakeGrok = join(home, 'fake-grok');
  const hookReport = `"${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report`;

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
if [ -f "$HOME/fake-claude-hold-start" ]; then sleep 30; exit 0; fi
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
      env: collectEnv({
        HOME: home,
        XDG_RUNTIME_DIR: home,
        PATH: '/usr/sbin:/usr/bin:/bin',
        ATC_SESSION_ID: options.callerSessionID ?? '',
        ATC_TAP_GRACE_MS: '0',
      }),
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
    'atc_agents_list',
    'atc_session_get',
    'atc_session_read',
    'atc_events_read',
    'atc_session_message',
    'atc_message_get',
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
    config: {
      gateways: {
        zai: { label: 'GLM (z.ai)', mark: 'z', baseURL: 'https://api.z.ai/api/anthropic' },
      },
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
    config: {
      gateways: {
        zai: {
          label: 'GLM (z.ai)',
          mark: 'z',
          baseURL: 'https://api.z.ai/api/anthropic',
          apiKeyHelper: '/usr/bin/true',
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
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

test('it nests a spawn from inside a session under that session', async () => {
  const outer = setupMCP();

  outer.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await outer.waitForResponse(1);

  outer.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: outer.home, name: 'wrangler' } },
  });

  const wranglerResponse = await outer.waitForResponse(2);

  const wrangler: unknown = JSON.parse(getText(getResult(wranglerResponse)));

  if (!isRecord(wrangler) || typeof wrangler['id'] !== 'string') {
    throw new TypeError('spawn answered without a session id');
  }

  const inner = setupMCP({ home: outer.home, callerSessionID: wrangler['id'] });

  inner.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await inner.waitForResponse(1);

  inner.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: outer.home, name: 'worker' } },
  });

  const workerResponse = await inner.waitForResponse(2);

  const worker = getResult(workerResponse);

  expect(worker['isError']).toBeUndefined();
  expect(getText(worker)).toInclude(`"parent": "${wrangler['id']}"`);
});

test('it spawns a top-level session from inside a session when detached is set', async () => {
  const outer = setupMCP();

  outer.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await outer.waitForResponse(1);

  outer.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: outer.home, name: 'wrangler' } },
  });

  const wranglerResponse = await outer.waitForResponse(2);

  const wrangler: unknown = JSON.parse(getText(getResult(wranglerResponse)));

  if (!isRecord(wrangler) || typeof wrangler['id'] !== 'string') {
    throw new TypeError('spawn answered without a session id');
  }

  const inner = setupMCP({ home: outer.home, callerSessionID: wrangler['id'] });

  inner.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await inner.waitForResponse(1);

  inner.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'atc_session_spawn',
      arguments: { cwd: outer.home, name: 'solo', detached: true },
    },
  });

  const soloResponse = await inner.waitForResponse(2);

  const solo = getResult(soloResponse);

  expect(solo['isError']).toBeUndefined();
  expect(getText(solo)).not.toInclude('"parent"');
});

test('it spawns a top-level session when the caller id matches no session', async () => {
  const ctx = setupMCP({ callerSessionID: 'ghost' });

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, name: 'stray' } },
  });

  const strayResponse = await ctx.waitForResponse(2);

  const stray = getResult(strayResponse);

  expect(stray['isError']).toBeUndefined();
  expect(getText(stray)).toInclude('"name": "stray"');
  expect(getText(stray)).not.toInclude('"parent"');
});

test('it reads a session record through a tool call', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_session_spawn', arguments: { cwd: ctx.home, prompt: 'say hi' } },
  });

  const spawnResponse = await ctx.waitForResponse(2);

  const spawned: unknown = JSON.parse(getText(getResult(spawnResponse)));

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new TypeError('spawn answer has no session id');
  }

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'atc_session_get', arguments: { session: spawned['id'] } },
  });

  const getResponse = await ctx.waitForResponse(3);

  const result = getResult(getResponse);
  const record: unknown = JSON.parse(getText(result));

  if (!isRecord(record)) {
    throw new TypeError('session record is not an object');
  }

  expect(result['isError']).toBeUndefined();
  expect(record).toMatchObject({ prompt: 'say hi', pending: null, result: null });
});

test('it pages a session transcript through a tool call', async () => {
  const ctx = setupMCP();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  );

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

  await waitFor(async () => {
    const id = rpcID++;

    ctx.sendRPC({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'atc_session_read', arguments: { session } },
    });

    const response = await ctx.waitForResponse(id);

    const parsed: unknown = JSON.parse(getText(getResult(response)));

    expect(parsed).toStrictEqual({
      rows: [
        { role: 'user', text: 'hello', tools: [], at: null },
        { role: 'assistant', text: 'hi there', tools: [], at: null },
      ],
      cursor: expect.toBeString(),
      more: false,
    });
  });
});

test('it reads fleet events through a tool call', async () => {
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

  await waitFor(async () => {
    const id = rpcID++;

    ctx.sendRPC({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'atc_events_read', arguments: {} },
    });

    const response = await ctx.waitForResponse(id);

    const parsed: unknown = JSON.parse(getText(getResult(response)));

    if (!isRecord(parsed)) {
      throw new TypeError('events answer is not an object');
    }

    expect(parsed['events']).toPartiallyContain({ kind: 'started', session });
  });
});

test('it answers a session list while an events long-poll is still waiting', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'atc_events_read', arguments: { waitMs: 2000 } },
  });

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'atc_session_list', arguments: {} },
  });

  const first = await Promise.race([ctx.waitForResponse(2), ctx.waitForResponse(3)]);

  expect(first['id']).toBe(3);

  const pollResponse = await ctx.waitForResponse(2);

  const pollResult = getResult(pollResponse);

  expect(pollResult['isError']).toBeUndefined();
  expect(JSON.parse(getText(pollResult))).toMatchObject({ events: [] });
});

test('it reports a message to a session with no tap as a failed tool call', async () => {
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

  await waitFor(async () => {
    const id = rpcID++;

    ctx.sendRPC({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'atc_session_list', arguments: {} },
    });

    const listResponse = await ctx.waitForResponse(id);

    const listed = getResult(listResponse);

    expect(getText(listed)).toInclude('"agentSessionID": "fake-1"');
  });

  const messageRPC = rpcID++;

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: messageRPC,
    method: 'tools/call',
    params: { name: 'atc_session_message', arguments: { session, text: 'hello' } },
  });

  const messageResponse = await ctx.waitForResponse(messageRPC);

  const result = getResult(messageResponse);

  expect(result['isError']).toBe(true);
  expect(getText(result)).toStartWith('unsupported:');
});

test('it sends a message to a session that has not started', async () => {
  const ctx = setupMCP();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

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

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'atc_session_message', arguments: { session: spawned['id'], text: 'hello' } },
  });

  const messageResponse = await ctx.waitForResponse(3);

  const result = getResult(messageResponse);

  expect(result['isError']).toBeUndefined();
  expect(getText(result)).toInclude('"status": "accepted"');
});

test('it reads a sent message back through atc_message_get', async () => {
  const ctx = setupMCP();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

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

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'atc_session_message',
      arguments: { session: spawned['id'], text: 'hello', from: 'tester' },
    },
  });

  const sentResponse = await ctx.waitForResponse(3);

  const sent: unknown = JSON.parse(getText(getResult(sentResponse)));

  if (!isRecord(sent) || typeof sent['message'] !== 'string') {
    throw new TypeError('message answer has no message id');
  }

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'atc_message_get', arguments: { message: sent['message'] } },
  });

  const getResponse = await ctx.waitForResponse(4);

  const got: unknown = JSON.parse(getText(getResult(getResponse)));

  expect(got).toStrictEqual({
    message: sent['message'],
    session: spawned['id'],
    from: 'tester',
    text: 'hello',
    status: 'accepted',
    sentAt: expect.toBeNumber() as number,
    turn: null,
    answeredWith: [],
  });
});

test('it holds atc_message_get over stdio until its wait ends', async () => {
  const ctx = setupMCP();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

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

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'atc_session_message',
      arguments: { session: spawned['id'], text: 'hello', from: 'tester' },
    },
  });

  const sentResponse = await ctx.waitForResponse(3);

  const sent: unknown = JSON.parse(getText(getResult(sentResponse)));

  if (!isRecord(sent) || typeof sent['message'] !== 'string') {
    throw new TypeError('message answer has no message id');
  }

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'atc_message_get', arguments: { message: sent['message'], waitMs: 500 } },
  });

  const start = Date.now();

  const getResponse = await ctx.waitForResponse(4);

  const got: unknown = JSON.parse(getText(getResult(getResponse)));

  expect(got).toMatchObject({ message: sent['message'], status: 'accepted' });
  expect(Date.now()).toBeWithin(start + 450, start + 5000);
});

test('it lists every tool with its three safety hints over stdio', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  const listResponse = await ctx.waitForResponse(2);

  const tools = getResult(listResponse)['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('tools is not an array');
  }

  const killTool: unknown = tools.find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_kill',
  );

  if (!isRecord(killTool)) {
    throw new TypeError('atc_session_kill is not listed');
  }

  expect(tools).toSatisfyAll(
    (tool) =>
      isRecord(tool) &&
      isRecord(tool['annotations']) &&
      typeof tool['annotations']['readOnlyHint'] === 'boolean' &&
      typeof tool['annotations']['destructiveHint'] === 'boolean' &&
      typeof tool['annotations']['openWorldHint'] === 'boolean',
  );

  expect(killTool['annotations']).toStrictEqual({
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
});

test('it answers an unsupported protocol version with the latest supported one', async () => {
  const ctx = setupMCP();

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test' } },
  });

  const response = await ctx.waitForResponse(1);

  expect(getResult(response)['protocolVersion']).toBe('2025-11-25');
});

test('it serves an older daemon over stdio with only what that daemon supports', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atc-mcp-legacy-'));
  const legacy = startLegacyDaemon(join(home, 'atc-daemon.sock'));

  onTestFinished(() => {
    legacy.stop();
  });

  const ctx = setupMCP({ home });

  ctx.sendRPC({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  await ctx.waitForResponse(1);

  ctx.sendRPC({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  ctx.sendRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'atc_message_get', arguments: { message: 'm-legacy', waitMs: 5000 } },
  });

  const listResponse = await ctx.waitForResponse(2);
  const callResponse = await ctx.waitForResponse(3);

  const listed = getResult(listResponse);
  const refused = getResult(callResponse);
  const tools = listed['tools'];

  if (!Array.isArray(tools)) {
    throw new TypeError('tools is not an array');
  }

  expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : null))).not.toContain(
    'atc_agents_list',
  );

  expect(refused['isError']).toBe(true);
  expect(getText(refused)).toStartWith('daemon_outdated: ');
  expect(legacy.requests.map((req) => req.m)).not.toContain('message.get');
});
