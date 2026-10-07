import { expect, test } from 'bun:test';
import { readJSONRecord } from '../test-utils/read-json-record';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../test-utils/setup-mcp-http';
import { collectGrants } from './collect-grants';

test('it lists a grant with its client, scopes, and when it was last used', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message',
    ticked: ['read', 'message'],
  });

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
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
  const unused = await collectGrants(server.store.db);

  const startedAt = Date.now();

  await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const [used] = await collectGrants(server.store.db);

  if (used?.lastUsedAt === null || used === undefined) {
    throw new Error('the grant holds no last use');
  }

  expect(unused).toStrictEqual([
    {
      grantID: expect.toBeString(),
      clientID,
      clientName: 'Claude',
      scopes: ['read', 'message'],
      createdAt: expect.toBeString(),
      lastUsedAt: null,
    },
  ]);

  expect(new Date(used.lastUsedAt).getTime()).toBeWithin(startedAt - 1000, Date.now() + 1);
});

test('it leaves out a grant whose refresh token was revoked', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
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

  await fetch(`${server.url}/oauth2/revoke`, {
    method: 'POST',
    body: new URLSearchParams({
      token: String(tokens['refresh_token']),
      token_type_hint: 'refresh_token',
      client_id: clientID,
    }),
  });

  const grants = await collectGrants(server.store.db);

  expect(grants).toStrictEqual([]);
});
