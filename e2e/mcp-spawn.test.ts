import { expect, test } from 'bun:test';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';
import { waitFor } from '../src/test-utils/wait-for';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { home: mcpHome.home, mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it spawns a session and lists it through tool calls', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.mcp.sendToolCall('atc_session_spawn', {
    cwd: ctx.home,
    name: 'mcp-spawned',
  });

  expect(spawned.isError).toBeUndefined();
  expect(spawned.text).toInclude('"name": "mcp-spawned"');
  expect(spawned.text).toInclude('"agent": "claude"');

  const listed = await ctx.mcp.sendToolCall('atc_session_list', {});

  expect(listed.text).toInclude('mcp-spawned');
});

test('it reads a session screen through a tool call', async () => {
  await using ctx = await setupTest();

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const screen = await waitFor(async () => {
    const result = await ctx.mcp.sendToolCall('atc_session_screen', { session });

    expect(result.isError).toBeUndefined();
    expect(result.text).toInclude('FAKE_CLAUDE_UP');

    return result.text;
  });

  expect(screen).toStartWith('FAKE_CLAUDE_UP args:');
});

test('it passes the model and effort of a spawn to the agent CLI', async () => {
  await using ctx = await setupTest();

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home, model: 'opus', effort: 'high' });

  const screen = await waitFor(async () => {
    const result = await ctx.mcp.sendToolCall('atc_session_screen', { session });

    expect(result.text).toInclude('FAKE_CLAUDE_UP');

    return result.text;
  });

  expect(screen).toStartWith('FAKE_CLAUDE_UP args: --model opus --effort high --settings');
});

test('it reports an unregistered agent id as a failed tool call', async () => {
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

  const failed = await ctx.mcp.sendToolCall('atc_session_spawn', { cwd: ctx.home, agent: '' });

  expect(failed).toStrictEqual({
    isError: true,
    text: expect.toInclude('session.spawn agent must be a non-empty agent id'),
    structured: undefined,
  });
});
