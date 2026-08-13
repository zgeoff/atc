import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { isRecord } from '../src/report';

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

function setupMCP(): MCPContext {
  const home = mkdtempSync(join(tmpdir(), 'atc-mcp-'));

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
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
