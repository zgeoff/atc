import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectClients } from './collect-clients';
import { openMCPAuth } from './open-mcp-auth';
import { removeClient } from './remove-client';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-remove-client-'));

  const store = await openMCPAuth({ dbPath: join(tmp.dir, 'mcp-auth.db'), origin: null });

  stack.defer(() => store.close());

  const owned = stack.move();

  return { store, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it removes a client and reports it removed', async () => {
  await using ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const removed = await removeClient(ctx.store.db, created.clientID);

  expect(removed).toBeTrue();
  expect(collectClients(ctx.store.db)).resolves.toStrictEqual([]);
});

test('it reports an unknown client id as not removed', async () => {
  await using ctx = await setupTest();

  const removed = await removeClient(ctx.store.db, 'unknown-client');

  expect(removed).toBeFalse();
});
