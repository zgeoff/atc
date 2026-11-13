import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerClient } from './seed-owner-client';
import { seedOwnerSchema } from './seed-owner-schema';
import { seedOwnerTokens } from './seed-owner-tokens';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const client = seedOwnerClient(sqlite, { name: 'Orchard' });

  return { sqlite, ownerID: owner.ownerID, clientID: client.clientID };
}

test('it writes a refresh token and its access token, each stored as its hash', () => {
  const ctx = setupTest();

  const tokens = seedOwnerTokens(ctx.sqlite, {
    ownerID: ctx.ownerID,
    clientID: ctx.clientID,
    grantID: 'code-pear-41',
    scopes: '["read","offline_access"]',
    resources: '["https://atc.example/mcp"]',
    createdAt: '2026-10-14T12:00:00.000Z',
    now: Date.parse('2026-10-14T12:00:00.000Z'),
  });

  expect({
    refresh: ctx.sqlite
      .query(
        'select "id", "token", "userId", "authorizationCodeId", "expiresAt" from "oauthRefreshToken"',
      )
      .all(),
    access: ctx.sqlite
      .query(
        'select "token", "refreshId", "authorizationCodeId", "expiresAt" from "oauthAccessToken"',
      )
      .all(),
  }).toStrictEqual({
    refresh: [
      {
        id: tokens.refreshID,
        token: createHash('sha256').update(tokens.refreshToken).digest('base64url'),
        userId: ctx.ownerID,
        authorizationCodeId: 'code-pear-41',
        expiresAt: '2026-11-13T12:00:00.000Z',
      },
    ],
    access: [
      {
        token: createHash('sha256').update(tokens.accessToken).digest('base64url'),
        refreshId: tokens.refreshID,
        authorizationCodeId: 'code-pear-41',
        expiresAt: '2026-10-14T13:00:00.000Z',
      },
    ],
  });
});
