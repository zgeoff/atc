import { expect, test } from 'bun:test';
import { readJSONRecord, registerTestCleanup } from '@atc/test-utils';
import { McpServer } from '@modelcontextprotocol/server';
import { createModernMCPHandler } from './create-modern-mcp-handler';

test('it builds the server of each request for the access its token verified to', async () => {
  const handler = createModernMCPHandler({
    createServer: (access) => {
      const server = new McpServer({ name: 'atc', version: 'atc/test-build' });

      server.registerTool('whoami', { description: 'Names the caller.' }, () => ({
        content: [{ type: 'text', text: access.clientName }],
      }));

      return server;
    },
  });

  registerTestCleanup(() => handler.close());

  const request = new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'whoami',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'whoami',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });

  const answered = await handler.answer(
    request,
    { clientID: 'client-one', clientName: 'Night Desk', scopes: ['read'] },
    { token: 'token-one', clientId: 'client-one', scopes: ['read'] },
  );

  const body = await readJSONRecord(answered);

  expect(body).toMatchObject({
    result: { content: [{ type: 'text', text: 'Night Desk' }] },
  });
});
