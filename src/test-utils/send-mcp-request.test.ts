import { expect, onTestFinished, test } from 'bun:test';
import { sendMCPRequest } from './send-mcp-request';

test('it posts one JSON-RPC request with the bearer token to the MCP endpoint', async () => {
  const received: unknown[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        type: request.headers.get('content-type'),
        body: await request.json(),
      });

      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    },
  });

  onTestFinished(() => server.stop(true));

  await sendMCPRequest(`http://127.0.0.1:${server.port}`, 'tok', 'tools/call', { name: 'x' });

  expect(received).toStrictEqual([
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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  });

  onTestFinished(() => server.stop(true));

  const result = await sendMCPRequest(`http://127.0.0.1:${server.port}`, 'tok', 'tools/list');

  expect(result).toStrictEqual({ tools: [] });
});

test('it refuses a response without a result', () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32_601, message: 'no method' } }),
  });

  onTestFinished(() => server.stop(true));

  expect(
    sendMCPRequest(`http://127.0.0.1:${server.port}`, 'tok', 'nope'),
  ).rejects.toThrowWithMessage(TypeError, 'result is not an object');
});
