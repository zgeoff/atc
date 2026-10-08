import { expect, onTestFinished, test } from 'bun:test';
import { isProcessAlive } from '../shared/is-process-alive';
import { buildStubMCPStdioServer } from './build-stub-mcp-stdio-server';
import { createStubBin } from './create-stub-bin';
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

  const held = ctx.mcp.sendToolCall('atc_events_read', { waitMs: 4000 });
  const stopping = ctx.mcp[Symbol.asyncDispose]();

  onTestFinished(() => stopping);

  expect(held).rejects.toThrowWithMessage(Error, /^atc mcp stopped answering before request 2$/);
});

test('it rejects a tool call whose response holds no result', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'no-result',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}',
    ]),
  );

  await using server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_session_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}',
  );
});

test('it rejects a tool call whose result holds no text item', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'no-item',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
    ]),
  );

  await using server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_session_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
  );
});

test('it rejects a tool call whose result holds two text items', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'two-items',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
    ]),
  );

  await using server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_session_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
  );
});

test('it rejects a tool call whose structured content is not an object', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'scalar-structured',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}',
    ]),
  );

  await using server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_session_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}',
  );
});

test('it rejects a pending request once the server prints a line that is not JSON', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'not-json',
    buildStubMCPStdioServer(['{"jsonrpc":"2.0","id":1,"result":{}}', 'not json']),
  );

  await using server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_session_list', {})).rejects.toThrowWithMessage(
    Error,
    'atc mcp stopped answering before request 2',
  );
});

test('it resolves a second disposal', async () => {
  await using ctx = await setupTest();

  await ctx.mcp[Symbol.asyncDispose]();

  expect(ctx.mcp[Symbol.asyncDispose]()).resolves.toBeUndefined();
});

test('it stops a server whose initialize fails before rejecting', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(ctx.home, 'bad-init', buildStubMCPStdioServer(['not json']));
  const starting = startMCPStdio({ home: ctx.home, command: [bin] });

  expect(starting).rejects.toThrowWithMessage(Error, 'atc mcp stopped answering before request 1');

  const recorded = await Bun.file(`${bin}.pid`).text();

  const pid = Number(recorded);

  expect(isProcessAlive(pid)).toBeFalse();
});

test('it stops the server once the test finishes without a dispose', async () => {
  const mcpHome = setupMCPHome();

  const bin = createStubBin(
    mcpHome.home,
    'stub-mcp',
    buildStubMCPStdioServer([JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })]),
  );

  await startMCPStdio({ home: mcpHome.home, command: [bin] });

  const recorded = await Bun.file(`${bin}.pid`).text();

  const pid = Number(recorded);

  onTestFinished(() => {
    expect(isProcessAlive(pid)).toBeFalse();
  });
});

test('it stops the server once when disposed before the test finishes', async () => {
  const mcpHome = setupMCPHome();

  const bin = createStubBin(
    mcpHome.home,
    'stub-mcp',
    buildStubMCPStdioServer([JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })]),
  );

  const server = await startMCPStdio({ home: mcpHome.home, command: [bin] });
  const recorded = await Bun.file(`${bin}.pid`).text();

  const pid = Number(recorded);

  await server[Symbol.asyncDispose]();

  expect(isProcessAlive(pid)).toBeFalse();
});
