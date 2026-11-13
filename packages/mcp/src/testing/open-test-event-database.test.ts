import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { openTestEventDatabase } from './open-test-event-database';

async function setupTest() {
  const store = await openTestEventDatabase();

  registerTestCleanup(() => store.close());

  return { store };
}

test('it opens the event tables beside the clients of the authorization server', async () => {
  const ctx = await setupTest();

  const client = await ctx.store.admin.clients.add('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
  ]);

  expect(
    ctx.store.db.selectFrom('oauthClient').select(['clientId', 'name']).execute(),
  ).resolves.toStrictEqual([{ clientId: client.clientID, name: 'Claude' }]);
});
