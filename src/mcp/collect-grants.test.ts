import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import { readJSONRecord } from '../test-utils/read-json-record';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectGrants } from './collect-grants';
import { openMCPAuth } from './open-mcp-auth';
import { ReconnectingCaller } from './reconnecting-caller';
import { startMCPHTTPServer } from './start-mcp-http-server';

// `atc mcp --http` on a free port with every approval line it prints
// collected, and its authorization server's database opened a second time
// the way `atc grants` opens it. No test reaches the daemon, so the caller
// points at a socket nothing listens on.
async function setupTest() {
  const tmp = setupTempDir('atc-collect-grants-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');
  const approvals: string[] = [];

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    dbPath,
    printApproval: (line) => {
      approvals.push(line);
    },
    printRequest: () => {},
  });

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, origin: null });

  registerTestCleanup(() => store.close());

  return { url: server.url, origin: server.origin, approvals, store };
}

test('it lists a grant with its client and scopes and no last use before the grant is used', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

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
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

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

  invariant(typeof lastUsedAt === 'string', 'the grant holds no last use');

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
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

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

test('it lists the grants oldest first', async () => {
  const ctx = await setupTest();

  const claude = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const chatGPT = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const claudeAuthorized = await runMCPAuthorization(ctx, {
    clientID: claude.clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: claudeAuthorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: claude.clientID,
      code_verifier: claudeAuthorized.verifier,
    }),
  });

  const chatGPTAuthorized = await runMCPAuthorization(ctx, {
    clientID: chatGPT.clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: chatGPTAuthorized.code,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      client_id: chatGPT.clientID,
      code_verifier: chatGPTAuthorized.verifier,
    }),
  });

  // The grant made last is the older one, so insertion order cannot pass
  // for creation order.
  await ctx.store.db
    .updateTable('oauthRefreshToken')
    .set({ createdAt: '2026-01-02T00:00:00.000Z' })
    .where('clientId', '=', claude.clientID)
    .execute();

  await ctx.store.db
    .updateTable('oauthRefreshToken')
    .set({ createdAt: '2026-01-01T00:00:00.000Z' })
    .where('clientId', '=', chatGPT.clientID)
    .execute();

  const grants = await collectGrants(ctx.store.db);

  expect(grants).toStrictEqual([
    {
      grantID: expect.toBeString(),
      clientID: chatGPT.clientID,
      clientName: 'ChatGPT',
      scopes: ['read'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    },
    {
      grantID: expect.toBeString(),
      clientID: claude.clientID,
      clientName: 'Claude',
      scopes: ['read'],
      createdAt: '2026-01-02T00:00:00.000Z',
      lastUsedAt: null,
    },
  ]);
});
