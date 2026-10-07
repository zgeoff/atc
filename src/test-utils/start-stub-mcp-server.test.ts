import { expect, test } from 'bun:test';
import { startStubMCPServer } from './start-stub-mcp-server';

test('it answers a request with the body it was given', async () => {
  using server = startStubMCPServer({ jsonrpc: '2.0', id: 1, result: { tools: [] } });

  const response = await fetch(`${server.url}/mcp`, { method: 'POST', body: '{}' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
});

test('it records the method, path, headers, and body of each request', async () => {
  using server = startStubMCPServer({});

  await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(server.requests).toStrictEqual([
    {
      method: 'POST',
      path: '/mcp',
      authorization: 'Bearer tok',
      type: 'application/json',
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    },
  ]);
});

test('it stops serving once disposed', () => {
  const server = startStubMCPServer({});

  server[Symbol.dispose]();

  expect(fetch(`${server.url}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow();
});
