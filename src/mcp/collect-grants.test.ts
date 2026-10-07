import { expect, test } from 'bun:test';
import { readJSONRecord } from '../test-utils/read-json-record';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../test-utils/setup-mcp-http';
import { collectGrants } from './collect-grants';

function setupTest() {
  return setupMCPHTTP();
}

test('it lists a grant with its client and scopes and no last use before the grant is used', async () => {
  await using ctx = await setupTest();

  const clientID = await ctx.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message',
    ticked: ['read', 'message'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const grants = await collectGrants(ctx.store.db);

  expect(grants).toStrictEqual([
    {
      grantID: expect.toBeString(),
      clientID,
      clientName: 'Claude',
      scopes: ['read', 'message'],
      createdAt: expect.toBeString(),
      lastUsedAt: null,
    },
  ]);
});

test('it lists when a grant was last used', async () => {
  await using ctx = await setupTest();

  const clientID = await ctx.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message',
    ticked: ['read', 'message'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const startedAt = Date.now();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const grants = await collectGrants(ctx.store.db);

  const lastUsedAt = grants[0]?.lastUsedAt;

  if (typeof lastUsedAt !== 'string') {
    throw new TypeError('the grant holds no last use');
  }

  expect(grants).toStrictEqual([
    {
      grantID: expect.toBeString(),
      clientID,
      clientName: 'Claude',
      scopes: ['read', 'message'],
      createdAt: expect.toBeString(),
      lastUsedAt,
    },
  ]);

  expect(Date.parse(lastUsedAt)).toBeWithin(startedAt - 1000, Date.now() + 1);
});

test('it leaves out a grant whose refresh token was revoked', async () => {
  await using ctx = await setupTest();

  const clientID = await ctx.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await fetch(`${ctx.url}/oauth2/revoke`, {
    method: 'POST',
    body: new URLSearchParams({
      token: String(tokens['refresh_token']),
      token_type_hint: 'refresh_token',
      client_id: clientID,
    }),
  });

  const grants = await collectGrants(ctx.store.db);

  expect(grants).toStrictEqual([]);
});
