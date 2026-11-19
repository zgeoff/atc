import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedDPoPBinding } from './seed-dpop-binding';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerSchema } from './seed-owner-schema';
import { seedOwnerTokens } from './seed-owner-tokens';
import { generateDPoPKey } from './sign-dpop-proof';

test('it writes the key thumbprint as the confirmation of each access token', async () => {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const client = seedOwnerClient(sqlite, { name: 'Orchard' });

  seedOwnerTokens(sqlite, {
    ownerID: owner.ownerID,
    clientID: client.clientID,
    grantID: 'code-pear-41',
    scopes: '["read"]',
    resources: '["https://atc.example/mcp"]',
    createdAt: '2026-11-19T12:00:00.000Z',
    now: Date.parse('2026-11-19T12:00:00.000Z'),
  });

  const key = await generateDPoPKey();

  seedDPoPBinding(sqlite, key);

  const [row] = sqlite.query('select "confirmation" from "oauthAccessToken"').all();

  expect(row).toStrictEqual({ confirmation: expect.stringMatching(/^\{"jkt":"[\w-]{43}"\}$/u) });
});
