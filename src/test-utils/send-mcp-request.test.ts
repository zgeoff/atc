import { expect, onTestFinished, test } from 'bun:test';
import { sendMCPRequest } from './send-mcp-request';
import { startStubMCPServer } from './start-stub-mcp-server';

test('it posts one JSON-RPC request with the bearer token to the MCP endpoint', async () => {
  using server = startStubMCPServer({ jsonrpc: '2.0', id: 1, result: {} });

  await sendMCPRequest(server.url, 'tok', 'tools/call', { name: 'x' });

  expect(server.requests).toStrictEqual([
    {
      method: 'POST',
      path: '/mcp',
      authorization: 'Bearer tok',
      type: 'application/json',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
    },
  ]);
});

test('it returns the result of the response', async () => {
  using server = startStubMCPServer({ jsonrpc: '2.0', id: 1, result: { tools: [] } });

  const result = await sendMCPRequest(server.url, 'tok', 'tools/list');

  expect(result).toStrictEqual({ tools: [] });
});

test('it refuses a response without a result', () => {
  const server = startStubMCPServer({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32_601, message: 'no method' },
  });

  onTestFinished(() => {
    server[Symbol.dispose]();
  });

  expect(sendMCPRequest(server.url, 'tok', 'nope')).rejects.toThrowWithMessage(
    TypeError,
    'result is not an object',
  );
});
