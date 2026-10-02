import { expect, test } from 'bun:test';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { collectClients } from './collect-clients';
import { removeClient } from './remove-client';

test('it removes a client', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);
  const removed = await removeClient(server.store.db, clientID);
  const clients = await collectClients(server.store.db);

  expect(removed).toBeTrue();
  expect(clients).toStrictEqual([]);
});

test('it reports an unknown client id as not removed', async () => {
  await using server = await setupMCPHTTP();

  const removed = await removeClient(server.store.db, 'unknown-client');

  expect(removed).toBeFalse();
});
