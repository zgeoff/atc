import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isProcessAlive } from '../shared/is-process-alive';
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

  expect(held).rejects.toThrowWithMessage(Error, /^atc mcp stopped answering before request 2$/);

  await stopping;
});

test('it rejects a tool call whose response holds no result', async () => {
  await using ctx = await setupTest();

  const bin = createStubBin(
    ctx.home,
    'no-result',
    `#!/usr/bin/env bash
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _
echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}'
exec cat > /dev/null
`,
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
    `#!/usr/bin/env bash
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _
echo '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}'
exec cat > /dev/null
`,
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
    `#!/usr/bin/env bash
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _
echo '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}'
exec cat > /dev/null
`,
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
    `#!/usr/bin/env bash
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _
echo '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}'
exec cat > /dev/null
`,
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
    `#!/usr/bin/env bash
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _
echo 'not json'
exec cat > /dev/null
`,
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

  const bin = createStubBin(
    ctx.home,
    'bad-init',
    `#!/usr/bin/env bash
echo $$ > "$HOME/bad-init-pid"
read -r _
echo 'not json'
exec cat > /dev/null
`,
  );

  const starting = startMCPStdio({ home: ctx.home, command: [bin] });

  expect(starting).rejects.toThrowWithMessage(Error, 'atc mcp stopped answering before request 1');

  const recorded = await Bun.file(join(ctx.home, 'bad-init-pid')).text();

  const pid = Number(recorded);

  expect(isProcessAlive(pid)).toBeFalse();
});
