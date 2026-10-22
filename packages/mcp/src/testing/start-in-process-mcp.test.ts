import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/daemon/testing';
import { startInProcessMCP } from './start-in-process-mcp';

async function setupTest() {
  const daemon = await startTestDaemon({ prefix: 'atc-in-process-mcp-' });

  return { daemon };
}

test("it answers a tool call with the daemon's own fleet", async () => {
  const ctx = await setupTest();

  const mcp = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
  });

  const listed = await mcp.sendToolCall('atc_sessions_list', {});

  expect(listed.isError).toBeUndefined();
  expect(listed.structured).toMatchObject({ sessions: [] });
});

test('it answers a tool call the daemon refuses with an error result', async () => {
  const ctx = await setupTest();

  const mcp = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
  });

  const read = await mcp.sendToolCall('atc_session_get', { session: 'nope' });

  expect(read.isError).toBeTrue();
});

test('it lists the tools after the initialize', async () => {
  const ctx = await setupTest();

  const mcp = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
  });

  const tools = await mcp.sendRequest('tools/list');

  expect(tools).toMatchObject({
    result: {
      tools: expect.arrayContaining([expect.objectContaining({ name: 'atc_session_spawn' })]),
    },
  });
});

test('it rejects a request still unanswered when the server stops', async () => {
  const ctx = await setupTest();

  const mcp = await startInProcessMCP({
    socketPath: ctx.daemon.socketPath,
    build: ctx.daemon.build,
  });

  const listed = mcp.sendToolCall('atc_sessions_list', {});

  await mcp.stop();

  expect(listed).rejects.toThrowWithMessage(
    Error,
    'the MCP server closed before it answered request 2',
  );
});
