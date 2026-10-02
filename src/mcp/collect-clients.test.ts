import { expect, test } from 'bun:test';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { collectClients } from './collect-clients';

test('it lists every client with its redirect URIs, oldest first', async () => {
  await using server = await setupMCPHTTP();

  const claude = await server.addClient('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ]);

  const chatGPT = await server.addClient('ChatGPT', [
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ]);

  const clients = await collectClients(server.store.db);

  expect(clients).toStrictEqual([
    {
      clientID: claude,
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
      createdAt: expect.toBeString(),
    },
    {
      clientID: chatGPT,
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      createdAt: expect.toBeString(),
    },
  ]);
});
