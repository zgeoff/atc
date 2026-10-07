import { expect, test } from 'bun:test';
import { isRecord } from '../src/shared/report';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const mcpHome = stack.use(setupMCPHome());

  const mcp = await startMCPStdio({ home: mcpHome.home });

  stack.use(mcp);

  const owned = stack.move();

  return { mcp, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it answers initialize with the requested protocol version and its server name', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test' },
  });

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'atc', version: expect.toBeString() },
    },
  });
});

test('it answers an unsupported protocol version with the latest supported one', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('initialize', {
    protocolVersion: '2099-01-01',
    capabilities: {},
    clientInfo: { name: 'test' },
  });

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'atc', version: expect.toBeString() },
    },
  });
});

test('it answers an unknown rpc method with a json-rpc error', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('bogus/method');

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32_601, message: "unknown method 'bogus/method'" },
  });
});

test('it lists the fleet tools', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('tools/list');

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        expect.objectContaining({ name: 'atc_session_list' }),
        expect.objectContaining({ name: 'atc_session_spawn' }),
        expect.objectContaining({ name: 'atc_session_input' }),
        expect.objectContaining({ name: 'atc_session_screen' }),
        expect.objectContaining({ name: 'atc_session_update' }),
        expect.objectContaining({ name: 'atc_session_kill' }),
        expect.objectContaining({ name: 'atc_session_forget' }),
        expect.objectContaining({ name: 'atc_session_ack' }),
        expect.objectContaining({ name: 'atc_resume_command' }),
        expect.objectContaining({ name: 'atc_dirs_list' }),
        expect.objectContaining({ name: 'atc_agents_list' }),
        expect.objectContaining({ name: 'atc_session_get' }),
        expect.objectContaining({ name: 'atc_session_read' }),
        expect.objectContaining({ name: 'atc_events_read' }),
        expect.objectContaining({ name: 'atc_report_get' }),
        expect.objectContaining({ name: 'atc_session_message' }),
        expect.objectContaining({ name: 'atc_message_get' }),
      ],
    },
  });
});

test('it lists every tool with its three safety hints', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('tools/list');

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        expect.objectContaining({
          name: 'atc_session_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_spawn',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_input',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_screen',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_update',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_kill',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_forget',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_ack',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_resume_command',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_dirs_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_agents_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_events_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_report_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_message',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_message_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
      ],
    },
  });
});

test('it marks the kill tool destructive and not read-only', async () => {
  await using ctx = await setupTest();

  const response = await ctx.mcp.sendRequest('tools/list');

  const result = response['result'];

  if (!isRecord(result) || !Array.isArray(result['tools'])) {
    throw new TypeError('tools/list returned no tools');
  }

  const killTool: unknown = result['tools'].find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_kill',
  );

  if (!isRecord(killTool)) {
    throw new TypeError('the kill tool is not listed');
  }

  expect(killTool['annotations']).toStrictEqual({
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
});

test('it keeps answering after a failed tool call', async () => {
  await using ctx = await setupTest();

  const failed = await ctx.mcp.sendToolCall('atc_session_kill', { session: 'nope' });

  expect(failed).toStrictEqual({
    isError: true,
    text: expect.toInclude('no_such_session'),
    structured: undefined,
  });

  const pong = await ctx.mcp.sendRequest('ping');

  expect(pong).toStrictEqual({ jsonrpc: '2.0', id: 3, result: {} });
});
