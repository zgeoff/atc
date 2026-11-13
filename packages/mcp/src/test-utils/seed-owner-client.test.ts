import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerSchema } from './seed-owner-schema';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  seedOwnerSchema(sqlite);

  return { sqlite };
}

test('it writes a client with the name it is given', () => {
  const ctx = setupTest();
  const client = seedOwnerClient(ctx.sqlite, { name: 'Orchard' });

  expect(
    ctx.sqlite.query('select "clientId", "name", "redirectUris" from "oauthClient"').all(),
  ).toStrictEqual([
    {
      clientId: client.clientID,
      name: 'Orchard',
      redirectUris: '["https://claude.ai/api/mcp/auth_callback"]',
    },
  ]);
});
