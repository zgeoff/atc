import { expect, onTestFinished, setSystemTime, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { openMCPAuth } from './open-mcp-auth';
import { readClientViews } from './read-client-views';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-collect-clients-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { store };
}

test('it lists every client with its redirect URIs, oldest first', async () => {
  const ctx = await setupTest();

  onTestFinished(() => {
    setSystemTime();
  });

  // The client added last is the older one, so insertion order cannot
  // pass for creation order. better-auth stamps a client's creation time
  // from the system clock.
  setSystemTime(new Date('2026-01-02T00:00:00.000Z'));

  const claude = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    },
  });

  setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

  const chatGPT = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const clients = await readClientViews(ctx.store.db);

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
