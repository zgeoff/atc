import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerGrant } from './seed-owner-grant';
import { seedOwnerRefresh } from './seed-owner-refresh';
import { seedOwnerSchema } from './seed-owner-schema';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const client = seedOwnerClient(sqlite, { name: 'Orchard' });

  const grant = seedOwnerGrant(sqlite, {
    ownerID: owner.ownerID,
    clientID: client.clientID,
    resource: 'https://atc.example/mcp',
    scopes: ['read'],
  });

  return { sqlite, grant };
}

test('it revokes the old refresh token and writes a new pair with the same grant ID', () => {
  const ctx = setupTest();
  const rotated = seedOwnerRefresh(ctx.sqlite, ctx.grant);

  expect(
    ctx.sqlite
      .query(
        'select "id", "authorizationCodeId", "revoked" is not null as "isRevoked" from "oauthRefreshToken" order by "isRevoked"',
      )
      .all(),
  ).toStrictEqual([
    { id: rotated.refreshID, authorizationCodeId: ctx.grant.grantID, isRevoked: 0 },
    { id: ctx.grant.refreshID, authorizationCodeId: ctx.grant.grantID, isRevoked: 1 },
  ]);
});
