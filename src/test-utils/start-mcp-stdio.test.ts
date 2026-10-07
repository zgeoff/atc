import { expect, test } from 'bun:test';
import { setupMCPHome } from './setup-mcp-home';
import { startMCPStdio } from './start-mcp-stdio';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { home: mcpHome.home, mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it resolves a request with its whole response under the next id', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('ping');

  expect(response).toStrictEqual({ jsonrpc: '2.0', id: 2, result: {} });
});

test('it resolves a tool call with its error flag, text, and structured content', async () => {
  await using ctx = await setupTest();

  const result = await ctx.mcp.sendToolCall('atc_session_list', {});

  expect(result).toStrictEqual({ isError: undefined, text: '[]', structured: { sessions: [] } });
});

test('it resolves a spawn with the id of the session it started', async () => {
  await using ctx = await setupTest();

  const id = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'harness' });
  const listed = await ctx.mcp.sendToolCall('atc_session_list', {});

  expect(listed.structured).toMatchObject({ sessions: [{ id, name: 'harness' }] });
});

test('it rejects a spawn the server refuses', async () => {
  await using ctx = await setupTest();

  expect(ctx.mcp.spawnSession({ cwd: ctx.home, agent: 'gemini' })).rejects.toThrowWithMessage(
    TypeError,
    /^spawn returned no session id: unsupported: no adapter for agent 'gemini'/,
  );
});

test('it starts a server that runs inside the caller session', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.mcp.spawnSession({ cwd: ctx.home, name: 'parent' });

  await using inner = await startMCPStdio({ home: ctx.home, callerSessionID: parent });

  const child = await inner.sendToolCall('atc_session_spawn', { cwd: ctx.home, name: 'child' });

  expect(child.structured).toMatchObject({ name: 'child', parent });
});

test('it rejects a request still pending when the server stops', async () => {
  await using ctx = await setupTest();

  const held = ctx.mcp.sendToolCall('atc_events_read', { waitMs: 30_000 });
  const stopping = ctx.mcp[Symbol.asyncDispose]();

  expect(held).rejects.toThrowWithMessage(Error, /^atc mcp stopped answering before request 2$/);

  await stopping;
});
