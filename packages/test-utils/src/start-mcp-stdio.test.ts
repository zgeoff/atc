import { expect, onTestFinished, test } from 'bun:test';
import { buildStubMCPStdioServer } from './build-stub-mcp-stdio-server';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { startMCPStdio } from './start-mcp-stdio';

// A home for the stand-in server each test writes and starts there. The
// cases that start the real server run end to end.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-mcp-stdio-');

  return { home: temporaryDirectory.path };
}

test('it rejects a tool call whose response holds no result', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'no-result',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}',
    ]),
  );

  const server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_sessions_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}',
  );
});

test('it rejects a tool call whose result holds no text item', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'no-item',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
    ]),
  );

  const server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_sessions_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
  );
});

test('it rejects a tool call whose result holds two text items', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'two-items',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
    ]),
  );

  const server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_sessions_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
  );
});

test('it rejects a tool call whose structured content is not an object', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'scalar-structured',
    buildStubMCPStdioServer([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}',
    ]),
  );

  const server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_sessions_list', {})).rejects.toThrowWithMessage(
    TypeError,
    'tool call returned an unexpected result: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}',
  );
});

test('it rejects a pending request once the server prints a line that is not JSON', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'not-json',
    buildStubMCPStdioServer(['{"jsonrpc":"2.0","id":1,"result":{}}', 'not json']),
  );

  const server = await startMCPStdio({ home: ctx.home, command: [bin] });

  expect(server.sendToolCall('atc_sessions_list', {})).rejects.toThrowWithMessage(
    Error,
    'atc mcp stopped answering before request 2',
  );
});

test('it resolves a second stop', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'stub-mcp',
    buildStubMCPStdioServer(['{"jsonrpc":"2.0","id":1,"result":{}}']),
  );

  const mcp = await startMCPStdio({ home: ctx.home, command: [bin] });

  await mcp.stop();

  expect(mcp.stop()).resolves.toBeUndefined();
});

test('it stops a server whose initialize fails before rejecting', async () => {
  const ctx = setupTest();
  const bin = createStubBin(ctx.home, 'bad-init', buildStubMCPStdioServer(['not json']));
  const starting = startMCPStdio({ home: ctx.home, command: [bin] });

  expect(starting).rejects.toThrowWithMessage(Error, 'atc mcp stopped answering before request 1');

  const recorded = await Bun.file(`${bin}.pid`).text();

  const pid = Number(recorded);

  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it stops the server once the test finishes without a stop', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.home,
    'stub-mcp',
    buildStubMCPStdioServer([JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })]),
  );

  await startMCPStdio({ home: ctx.home, command: [bin] });

  const recorded = await Bun.file(`${bin}.pid`).text();

  const pid = Number(recorded);

  onTestFinished(() => {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});
