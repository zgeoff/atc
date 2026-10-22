import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startInProcessMCP } from '@atc/mcp/testing';
import { getRecords, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// The MCP tools in the test's process, against a daemon in it whose Claude is
// the in-process stand-in.
async function setupTest() {
  const stub = await startStubAgentDaemon();

  const mcp = await startInProcessMCP({
    socketPath: stub.daemon.socketPath,
    build: stub.daemon.build,
  });

  return { home: stub.home, mcp };
}

test('it spawns a session and lists it through tool calls', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    name: 'mcp-spawned',
  });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"name": "mcp-spawned"');
  expect(spawned.text).toInclude('"agent": "claude"');

  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(listed.text).toInclude('mcp-spawned');
});

test('it reads a session screen through a tool call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const screen = await waitFor(async () => {
    const result = await ctx.mcp.sendToolCall('atc_terminal_read', { session });

    expect(result.isError).toBeUndefined();
    expect(result.text).toInclude('FAKE_CLAUDE_UP');

    return result.text;
  });

  expect(screen).toStartWith('FAKE_CLAUDE_UP args:');
});

test('it passes the model and effort of a spawn to the agent CLI', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, model: 'opus', effort: 'high' });

  const screen = await waitFor(async () => {
    const result = await ctx.mcp.sendToolCall('atc_terminal_read', { session });

    expect(result.text).toInclude('FAKE_CLAUDE_UP');

    return result.text;
  });

  expect(screen).toStartWith('FAKE_CLAUDE_UP args: --model opus --effort high --add-dir ');
});

test('it passes the plugin folders of a spawn to the agent CLI with ~ expanded', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, pluginDirs: ['~/plugins/band'] });

  const screen = await waitFor(async () => {
    const result = await ctx.mcp.sendToolCall('atc_terminal_read', { session });

    expect(result.text).toInclude('FAKE_CLAUDE_UP');

    return result.text;
  });

  // The terminal wraps the argument line, so the check drops every space and
  // line break.
  expect(screen.replaceAll(/\s/gu, '')).toEndWith(
    `--plugin-dir${join(ctx.home, 'plugins', 'band')}`,
  );
});

test('it shows the plugin folders a session was spawned with in atc_session_get', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, pluginDirs: ['~/plugins/band'] });
  const got = await ctx.mcp.sendToolCall('atc_session_get', { session });

  expect(got.structured).toMatchObject({
    session: { id: session, pluginDirs: [join(ctx.home, 'plugins', 'band')] },
  });
});

test('it reports plugin folders as a spawn option of claude in atc_spawn_options_get', async () => {
  const ctx = await setupTest();
  const options = await ctx.mcp.sendToolCall('atc_spawn_options_get', {});

  invariant(options.structured, 'expected structured content');

  const claude = getRecords(options.structured, 'agents').find((agent) => agent['id'] === 'claude');

  expect(claude).toMatchObject({
    spawnOptions: { pluginDirs: { supported: true, available: true } },
  });
});

test('it reports an unregistered agent id as a failed tool call', async () => {
  const ctx = await setupTest();

  const failed = await ctx.mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    agent: 'gemini',
  });

  expect(failed).toStrictEqual({
    isError: true,
    text: expect.toInclude("unsupported: no adapter for agent 'gemini'"),
    structured: undefined,
  });
});

test('it rejects an empty agent id as a failed tool call', async () => {
  const ctx = await setupTest();
  const failed = await ctx.mcp.sendToolCall('atc_session_spawn', { cwd: ctx.home, agent: '' });

  expect(failed).toStrictEqual({
    isError: true,
    text: 'Input validation error: Invalid arguments for tool atc_session_spawn: data/agent must NOT have fewer than 1 characters',
    structured: undefined,
  });
});

test('it stops a session without removing it and forgets it in a later call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const first = await ctx.mcp.sendToolCall('atc_session_stop', { session });
  const second = await ctx.mcp.sendToolCall('atc_session_stop', { session });
  const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(first.structured).toStrictEqual({ stopped: true });
  expect(second.structured).toStrictEqual({ stopped: false });
  expect(listed.text).toInclude(session);

  const forgotten = await ctx.mcp.sendToolCall('atc_session_forget', { session });
  const after = await ctx.mcp.sendToolCall('atc_sessions_list', {});

  expect(forgotten.structured).toStrictEqual({ forgotten: true, destroyed: false });
  expect(after.text).not.toInclude(session);
});
