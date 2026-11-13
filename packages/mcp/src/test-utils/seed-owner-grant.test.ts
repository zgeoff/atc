import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerGrant } from './seed-owner-grant';
import { seedOwnerSchema } from './seed-owner-schema';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const client = seedOwnerClient(sqlite, { name: 'Orchard' });

  return { sqlite, ownerID: owner.ownerID, clientID: client.clientID };
}

test('it writes a consent and a token pair on the owner row, with offline_access added', () => {
  const ctx = setupTest();

  const grant = seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: ctx.clientID,
    resource: 'https://atc.example/mcp',
    scopes: ['read'],
  });

  expect({
    consents: ctx.sqlite.query('select "userId", "scopes", "resources" from "oauthConsent"').all(),
    tokens: ctx.sqlite
      .query('select "userId", "authorizationCodeId", "scopes" from "oauthRefreshToken"')
      .all(),
  }).toStrictEqual({
    consents: [
      {
        userId: ctx.ownerID,
        scopes: '["read","offline_access"]',
        resources: '["https://atc.example/mcp"]',
      },
    ],
    tokens: [
      {
        userId: ctx.ownerID,
        authorizationCodeId: grant.grantID,
        scopes: '["read","offline_access"]',
      },
    ],
  });
});

test('it stamps the tokens with the grant ID it is given', () => {
  const ctx = setupTest();

  seedOwnerGrant(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: ctx.clientID,
    resource: 'https://atc.example/mcp',
    scopes: ['read'],
    grantID: '-code-plum-7',
  });

  expect(
    ctx.sqlite.query('select "authorizationCodeId" from "oauthAccessToken"').all(),
  ).toStrictEqual([{ authorizationCodeId: '-code-plum-7' }]);
});
