import { expect, test } from 'bun:test';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';
import { waitFor } from '../src/test-utils/wait-for';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
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

  expect(screen).toStartWith('FAKE_CLAUDE_UP args: --model opus --effort high --settings');
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
    text: expect.toInclude('session.spawn agent must be a non-empty agent id'),
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
