import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectClients } from './collect-clients';
import { openMCPAuth } from './open-mcp-auth';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-collect-clients-'));

  const store = await openMCPAuth({ dbPath: join(tmp.dir, 'mcp-auth.db'), origin: null });

  stack.defer(() => store.close());

  const owned = stack.move();

  return { store, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it lists every client with its redirect URIs, oldest first', async () => {
  await using ctx = await setupTest();

  const claude = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    },
  });

  const chatGPT = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const clients = await collectClients(ctx.store.db);

  expect(clients).toStrictEqual([
    {
      clientID: claude.clientID,
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
      createdAt: expect.toBeString(),
    },
    {
      clientID: chatGPT.clientID,
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      createdAt: expect.toBeString(),
    },
  ]);
});
