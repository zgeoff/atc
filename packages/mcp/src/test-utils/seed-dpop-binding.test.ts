import { expect, test } from 'bun:test';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { registerTestCleanup } from '@zgeoff/testing';
import { seedDPoPBinding } from './seed-dpop-binding';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerSchema } from './seed-owner-schema';
import { seedOwnerTokens } from './seed-owner-tokens';
import { generateDPoPKey } from './sign-dpop-proof';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  return { sqlite };
}

test('it writes the key thumbprint as the confirmation of each access token', async () => {
  const ctx = setupTest();
  const owner = seedOwnerSchema(ctx.sqlite);
  const client = seedOwnerClient(ctx.sqlite, { name: 'Orchard' });

  seedOwnerTokens(ctx.sqlite, {
    ownerID: owner.ownerID,
    clientID: client.clientID,
    grantID: 'code-pear-41',
    scopes: '["read"]',
    resources: '["https://atc.example/mcp"]',
    createdAt: '2026-11-19T12:00:00.000Z',
    now: Date.parse('2026-11-19T12:00:00.000Z'),
  });

  const key = await generateDPoPKey();

  seedDPoPBinding(ctx.sqlite, key);

  const [row] = ctx.sqlite.query('select "confirmation" from "oauthAccessToken"').all();

  expect(row).toStrictEqual({ confirmation: expect.stringMatching(/^\{"jkt":"[\w-]{43}"\}$/u) });
});
