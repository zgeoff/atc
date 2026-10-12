import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectClients } from './collect-clients';
import { openMCPAuth } from './open-mcp-auth';

async function setupTest() {
  const tmp = setupTempDir('atc-collect-clients-');

  const store = await openMCPAuth({ dbPath: join(tmp.dir, 'mcp-auth.db'), origin: null });

  registerTestCleanup(() => store.close());

  return { store };
}

test('it lists every client with its redirect URIs, oldest first', async () => {
  const ctx = await setupTest();

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

  // The client added last is the older one, so insertion order cannot
  // pass for creation order.
  await ctx.store.db
    .updateTable('oauthClient')
    .set({ createdAt: '2026-01-02T00:00:00.000Z' })
    .where('clientId', '=', claude.clientID)
    .execute();

  await ctx.store.db
    .updateTable('oauthClient')
    .set({ createdAt: '2026-01-01T00:00:00.000Z' })
    .where('clientId', '=', chatGPT.clientID)
    .execute();

  const clients = await collectClients(ctx.store.db);

  expect(clients).toStrictEqual([
    {
      clientID: chatGPT.clientID,
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      clientID: claude.clientID,
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ]);
});
