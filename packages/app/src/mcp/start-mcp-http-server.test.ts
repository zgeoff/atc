import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  buildStubClock,
  parsePasskeyPage,
  readJSONRecord,
  registerTestCleanup,
  runMCPAuthorization,
  runPasskeyEnrollment,
  runPasskeySignIn,
  setupTempDir,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { collectGrants } from './collect-grants';
import { createEnrollmentToken } from './create-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';
import { removeClient } from './remove-client';
import { resetPasskeys } from './reset-passkeys';
import { revokeGrant } from './revoke-grant';
import { startMCPHTTPServer } from './start-mcp-http-server';
import { TransportCaller } from './transport-caller';

// the caller, the server, and the database live in the daemon's directory, so
// each registers its release to run before that directory goes.
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-mcp-http-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const dbPath = join(daemon.dir, 'mcp-auth.db');
  const requests: string[] = [];
  const security: string[] = [];

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  // The approval clock stands still, so every approval a test starts falls
  // inside one minute however long the test runs.
  const clock = buildStubClock(Date.now());

  const startServer = (port: number, trustForwardedFrom: readonly string[] = []) =>
    startMCPHTTPServer({
      caller,
      build: 'atc/test-build',
      host: '127.0.0.1',
      port,
      publicURL: null,
      allowedHosts: [],
      trustForwardedFrom,
      dbPath,
      openAuthDatabase: openMCPAuthDatabase,
      printRequest: (line) => {
        requests.push(line);
      },
      printSecurity: (line) => {
        security.push(line);
      },
      clock,
    });

  let server = await startServer(0);

  registerTestCleanup(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, clock.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  // The lines the enrollment printed are not part of any scenario.
  requests.length = 0;
  security.length = 0;

  return {
    dir: daemon.dir,
    socketPath: daemon.socketPath,
    dbPath,
    url: server.url,
    origin: server.origin,
    authenticator,
    requests,
    security,
    clock,
    caller,
    store,

    // Stops the server and starts a fresh process's worth of it on the same
    // port and database, as an operator's restart does, trusting the
    // forwarded address from the proxies given.
    async restartServer(trustForwardedFrom: readonly string[] = []): Promise<void> {
      const port = Number(new URL(server.url).port);

      await server.stop();

      server = await startServer(port, trustForwardedFrom);
    },
  };
}

test('it advertises public clients with PKCE, issuer responses, and no registration', async () => {
  const ctx = await setupTest();
  const answered = await fetch(`${ctx.url}/.well-known/oauth-authorization-server`);
  const metadata = await readJSONRecord(answered);

  expect(metadata).toMatchObject({
    issuer: ctx.origin,
    authorization_endpoint: `${ctx.origin}/oauth2/authorize`,
    token_endpoint: `${ctx.origin}/oauth2/token`,
    revocation_endpoint: `${ctx.origin}/oauth2/revoke`,
    scopes_supported: ['read', 'message', 'spawn', 'kill', 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  });

  expect(Object.keys(metadata)).not.toIncludeAnyMembers([
    'registration_endpoint',
    'introspection_endpoint',
  ]);

  expect(Object.keys(metadata)).toSatisfyAll((key: string) => !key.startsWith('dpop_'));
});

test.each([
  ['/.well-known/oauth-protected-resource'],
  ['/.well-known/oauth-protected-resource/mcp'],
])('it serves the protected resource metadata at %p', async (path) => {
  const ctx = await setupTest();
  const answered = await fetch(`${ctx.url}${path}`);
  const metadata = await readJSONRecord(answered);

  expect(metadata).toMatchObject({
    resource: `${ctx.origin}/mcp`,
    authorization_servers: [ctx.origin],
    scopes_supported: ['read', 'message', 'spawn', 'kill'],
  });

  expect(Object.keys(metadata)).toSatisfyAll((key: string) => !key.startsWith('dpop_'));
});

test('it challenges a request without a token with where to find the resource metadata', async () => {
  const ctx = await setupTest();

  const answered = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(answered.status).toBe(401);

  expect(answered.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource/mcp"`,
  );
});

test('it issues an access and refresh token for an approved authorization code', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message kill',
    ticked: ['read', 'kill'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  expect(exchanged.status).toBe(200);

  expect(tokens).toStrictEqual({
    access_token: expect.toBeString(),
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: expect.toBeNumber(),
    refresh_token: expect.toBeString(),
    scope: 'read kill offline_access',
  });
});

test('it returns to the client with the issuer and the state it sent', async () => {
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

  expect(`${authorized.callback.origin}${authorized.callback.pathname}`).toBe(
    'https://claude.ai/api/mcp/auth_callback',
  );

  expect(Object.fromEntries(authorized.callback.searchParams)).toStrictEqual({
    code: authorized.code,
    state: 'state-1',
    iss: ctx.origin,
  });
});

test('it runs a tool call whose scope the token holds', async () => {
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

  const listed = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens['access_token'])}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    }),
  });

  const body: unknown = await listed.json();

  expect(listed.status).toBe(200);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }], structuredContent: { sessions: [] } },
  });
});

test('it shows a remote MCP client the sessions of the targets the principals grant to its client id', async () => {
  const tmp = setupTempDir('atc-mcp-http-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const created = await store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-mcp-http-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      principals: new Map([[created.clientID, ['local']]]),
    }),
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => server.stop());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  const spawned = await caller.sendRequest('session.spawn', { cwd: daemon.dir });

  const authorized = await runMCPAuthorization(
    { url: server.url, origin: server.origin, authenticator },
    {
      clientID: created.clientID,
      redirectURI: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const listed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens['access_token'])}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    }),
  });

  const body: unknown = await listed.json();

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify([spawned['session']], null, 2) }],
      structuredContent: { sessions: [spawned['session']] },
    },
  });
});

test('it shows a remote MCP client no sessions when the principals grant the targets to another client id', async () => {
  const tmp = setupTempDir('atc-mcp-http-');
  const dbPath = join(tmp.dir, 'mcp-auth.db');

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  const created = await store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-mcp-http-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      principals: new Map([['someone-else', ['local']]]),
    }),
  });

  const caller = new TransportCaller(daemon.socketPath, daemon.build, (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => server.stop());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  await caller.sendRequest('session.spawn', { cwd: daemon.dir });

  const authorized = await runMCPAuthorization(
    { url: server.url, origin: server.origin, authenticator },
    {
      clientID: created.clientID,
      redirectURI: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'read',
      ticked: ['read'],
    },
  );

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const listed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens['access_token'])}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    }),
  });

  const body: unknown = await listed.json();

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }], structuredContent: { sessions: [] } },
  });
});

test('it refuses a tool call for a scope the operator left unticked with insufficient_scope', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read spawn',
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

  invariant(
    tokens['scope'] === 'read offline_access',
    'the grant holds more than the ticked scope',
  );

  const spawned = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens['access_token'])}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_session_spawn', arguments: { cwd: ctx.dir } },
    }),
  });

  const body: unknown = await spawned.json();

  expect(spawned.status).toBe(403);

  expect(spawned.headers.get('www-authenticate')).toBe(
    `Bearer error="insufficient_scope", scope="spawn", resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource/mcp"`,
  );

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32_001, message: 'this grant lacks the spawn scope' },
  });
});

test('it refuses consent to a scope the client did not request', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  invariant(consent.pathname === '/consent', 'the passkey sign-in did not reach the consent page');

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const form = new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' });

  form.append('scope', 'read');
  form.append('scope', 'kill');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it denies the request when the operator allows nothing', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' }),
  });

  const callback = new URL(consented.headers.get('location') ?? '/', ctx.url);

  expect(`${callback.origin}${callback.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(callback.searchParams)).toStrictEqual({
    error: 'access_denied',
    error_description: 'User denied access',
    state: 'state-1',
    iss: ctx.origin,
  });

  expect(consented.headers.get('set-cookie')).toMatch(/session_token=; Max-Age=0;/u);
});

test('it shows the consent page on every authorization of a client', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const first = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const second = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  expect(`${second.consent.origin}${second.consent.pathname}`).toBe(`${ctx.url}/consent`);
  expect(second.code).not.toBe(first.code);
});

test('it binds a token to /mcp when the client names no resource', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;
  const verifier = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  const callback = new URL(consented.headers.get('location') ?? '/', ctx.url);

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const pinged = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it asks a browser that kept its owner session for a fresh passkey sign-in', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const first = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(first.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(cookie.includes('session_token='), 'the login set no owner session');

  const second = await fetch(authorize, { redirect: 'manual', headers: { cookie } });

  const next = new URL(second.headers.get('location') ?? '/', ctx.url);

  expect(next.pathname).toBe('/login');
});

test('it refuses an access token once its grant is revoked', async () => {
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
  const [grant] = await collectGrants(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  const before = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  invariant(before.status === 200, 'the token did not work before the revoke');

  await revokeGrant(ctx.store.db, grant.grantID);

  const after = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  expect(after.status).toBe(401);
});

test('it refuses to refresh a token once its grant is revoked', async () => {
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
  const [grant] = await collectGrants(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  const before = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  invariant(before.status === 200, 'the token did not work before the revoke');

  await revokeGrant(ctx.store.db, grant.grantID);

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(refreshed.status).toBe(400);
});

test('it shows the consent page again to a client whose grant was revoked', async () => {
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

  const [grant] = await collectGrants(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  await revokeGrant(ctx.store.db, grant.grantID);

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const again = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(again.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const next = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const page = await fetch(next, { headers: { cookie } });
  const html = await page.text();

  expect(next.pathname).toBe('/consent');
  expect(html).toInclude('value="read" checked');
});

test('it rotates a refresh token into a new one with the same scope', async () => {
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

  const first = await readJSONRecord(exchanged);

  const rotated = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  const second = await readJSONRecord(rotated);

  expect(rotated.status).toBe(200);
  expect(second['refresh_token']).toBeString();
  expect(second['refresh_token']).not.toBe(first['refresh_token']);
  expect(second['scope']).toBe('read offline_access');
});

test('it refuses a spent refresh token as invalid_grant', async () => {
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

  const first = await readJSONRecord(exchanged);

  const rotated = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  await readJSONRecord(rotated);

  const replayed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  const replay = await readJSONRecord(replayed);

  expect(replayed.status).toBe(400);

  expect(replay).toStrictEqual({
    error: 'invalid_grant',
    error_description: 'invalid refresh token',
  });
});

test('it refuses the successor of a refresh token once the spent one is replayed', async () => {
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

  const first = await readJSONRecord(exchanged);

  const rotated = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  const second = await readJSONRecord(rotated);

  const replayed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  await readJSONRecord(replayed);

  const successor = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(second['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(successor.status).toBe(400);
});

test('it refuses a reused authorization code and revokes what the first use issued', async () => {
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

  const exchange = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorized.code,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    client_id: clientID,
    code_verifier: authorized.verifier,
  });

  const first = await fetch(`${ctx.url}/oauth2/token`, { method: 'POST', body: exchange });

  invariant(first.status === 200, 'the first exchange failed');

  const tokens = await readJSONRecord(first);
  const second = await fetch(`${ctx.url}/oauth2/token`, { method: 'POST', body: exchange });
  const refusal = await readJSONRecord(second);

  const pinged = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(second.status).toBe(400);
  expect(refusal).toStrictEqual({ error: 'invalid_grant', error_description: 'invalid code' });
  expect(pinged.status).toBe(401);
});

test.each([
  ['https://claude.ai/api/mcp/auth_callback/'],
  ['https://claude.ai/api/mcp/auth_callback?x=1'],
  ['https://claude.ai/api/mcp/auth_callbacK'],
  ['https://attacker.example/cb'],
])('it refuses the redirect URI %p without redirecting to it', async (redirectURI) => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: redirectURI,
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  const location = new URL(answered.headers.get('location') ?? '/', ctx.url);

  expect(`${location.origin}${location.pathname}`).toBe(`${ctx.origin}/error`);
  expect(ctx.security).toSatisfyAll((line: string) => !line.includes('"kind":"authorize_started"'));
});

test('it refuses an authorization for another resource with invalid_target', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://other.example/mcp',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  const location = new URL(answered.headers.get('location') ?? '/', ctx.url);

  expect(`${location.origin}${location.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    error: 'invalid_target',
    error_description: 'requested resource https://other.example/mcp is not configured',
    state: 'state-1',
    iss: ctx.origin,
  });

  expect(ctx.security).toSatisfyAll((line: string) => !line.includes('"kind":"authorize_started"'));
});

test('it refuses a code exchange for another resource with invalid_target', async () => {
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
      resource: 'https://other.example/mcp',
    }),
  });

  const refusal = await readJSONRecord(exchanged);

  expect(exchanged.status).toBe(400);

  expect(refusal).toStrictEqual({
    error: 'invalid_target',
    error_description: 'requested resource not authorized',
  });
});

test('it refuses an authorization without PKCE before asking the operator', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  const location = new URL(answered.headers.get('location') ?? '/', ctx.url);

  expect(`${location.origin}${location.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    error: 'invalid_request',
    error_description: 'pkce is required for public clients',
    state: 'state-1',
    iss: ctx.origin,
  });

  expect(ctx.security).toSatisfyAll((line: string) => !line.includes('"kind":"authorize_started"'));
});

test('it refuses a code exchange with the wrong PKCE verifier', async () => {
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
      code_verifier: 'wrong-verifier-0123456789-abcdefghijklmnopqrstuvwxyz',
    }),
  });

  const refusal = await readJSONRecord(exchanged);

  expect(exchanged.status).toBe(401);

  expect(refusal).toStrictEqual({
    error: 'invalid_request',
    error_description: 'code verification failed',
  });
});

test('it refuses an eleventh authorization started within a minute', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const statuses = [];

  for (let started = 0; started < 11; started += 1) {
    const answered = await fetch(authorize, { redirect: 'manual' });

    statuses.push(answered.status);
  }

  expect(statuses).toStrictEqual([302, 302, 302, 302, 302, 302, 302, 302, 302, 302, 429]);
  expect(ctx.security.filter((line) => line.includes('"outcome":"accepted"'))).toBeArrayOfSize(10);
});

test("it ends a client's oldest approval when the client starts a fourth", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;
  const logins = [];

  // Each request carries its own state, as a client's separate attempts do,
  // so the four approvals stay distinct within one millisecond.
  for (let started = 0; started < 4; started += 1) {
    const authorize = new URL(`${ctx.url}/oauth2/authorize`);

    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'read',
      state: `attempt-${started}`,
      code_challenge: createHash('sha256')
        .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
        .digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();

    const answered = await fetch(authorize, { redirect: 'manual' });

    logins.push(new URL(answered.headers.get('location') ?? '/', ctx.url));
  }

  const pages = [];

  for (const login of logins) {
    const page = await fetch(login);

    pages.push(page.status);
  }

  expect(pages).toStrictEqual([400, 200, 200, 200]);
});

test('it refuses a request whose Host header it does not serve', async () => {
  const ctx = await setupTest();

  const answered = await fetch(`${ctx.url}/.well-known/oauth-authorization-server`, {
    headers: { host: 'rebound.example' },
  });

  expect(answered.status).toBe(403);
});

test('it serves a request whose Host header is a configured allowed host', async () => {
  const ctx = await setupTest();

  const allowing = await startMCPHTTPServer({
    caller: ctx.caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: ['pc.tailnet.example'],
    trustForwardedFrom: [],
    dbPath: join(ctx.dir, 'allowing-mcp-auth.db'),
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => allowing.stop());

  const answered = await fetch(`${allowing.url}/.well-known/oauth-protected-resource/mcp`, {
    headers: { host: 'pc.tailnet.example' },
  });

  expect(answered.status).toBe(200);
});

test.each([['/login'], ['/consent']])(
  'it refuses a form post to %p from another origin',
  async (path) => {
    const ctx = await setupTest();

    const answered = await fetch(`${ctx.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
      },
      body: 'oauth_query=a&code=b',
    });

    expect(answered.status).toBe(403);
  },
);

test.each([['/login'], ['/consent']])(
  'it refuses a form post to %p without an origin',
  async (path) => {
    const ctx = await setupTest();

    const answered = await fetch(`${ctx.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'oauth_query=a&code=b',
    });

    expect(answered.status).toBe(403);
  },
);

test('it refuses an MCP request from a browser on another origin', async () => {
  const ctx = await setupTest();

  const answered = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(answered.status).toBe(403);
});

test('it sends its pages with headers that keep them out of frames and caches', async () => {
  const ctx = await setupTest();
  const answered = await fetch(`${ctx.url}/login?unknown=1`);

  expect(answered.headers.get('content-security-policy')).toInclude("frame-ancestors 'none'");
  expect(answered.headers.get('x-frame-options')).toBe('DENY');
  expect(answered.headers.get('cache-control')).toBe('no-store');
  expect(answered.headers.get('referrer-policy')).toBe('same-origin');
});

test.each([
  ['/oauth2/create-client'],
  ['/oauth2/register'],
  ['/oauth2/introspect'],
  ['/sign-up/email'],
  ['/atc/sign-in-owner'],
])('it answers POST %p with 404', async (path) => {
  const ctx = await setupTest();

  const answered = await fetch(`${ctx.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(answered.status).toBe(404);
});

test.each([['/oauth2/get-clients'], ['/list-sessions']])(
  'it answers GET %p with 404',
  async (path) => {
    const ctx = await setupTest();
    const answered = await fetch(`${ctx.url}${path}`);

    expect(answered.status).toBe(404);
  },
);

test('it keeps serving an access token once the exchange deletes the session that approved it', async () => {
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

  const pinged = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it refreshes a token once the exchange deletes the session that approved it', async () => {
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

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(refreshed.status).toBe(200);
});

test('it serves a token refreshed once the exchange deletes the session that approved it', async () => {
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

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  const fresh = await readJSONRecord(refreshed);

  const pinged = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(fresh['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it refuses the access token of a removed client', async () => {
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
  const removed = await removeClient(ctx.store.db, clientID);

  invariant(removed, 'the client was not removed');

  const pinged = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(401);
});

test('it refuses the refresh token of a removed client', async () => {
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
  const removed = await removeClient(ctx.store.db, clientID);

  invariant(removed, 'the client was not removed');

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(refreshed.status).toBe(400);
});

test('it refuses a token bound to the resource of an earlier public URL', async () => {
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

  const caller = new TransportCaller(ctx.socketPath, 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const moved = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'http://localhost:9',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: ctx.dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => moved.stop());

  const pinged = await fetch(`${moved.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(401);
});

test.each([
  ['0.0.0.0', null],
  ['0.0.0.0', 'http://localhost:8414'],
  ['192.168.1.10', null],
])('it refuses to listen on %p with the public URL %p', (host, publicURL) => {
  const tmp = setupTempDir('atc-mcp-http-');

  const caller = new TransportCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const started = startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host,
    port: 0,
    publicURL,
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  expect(started).rejects.toThrow(/needs an https public URL/u);
});

test('it listens beyond loopback behind an https public URL', async () => {
  const tmp = setupTempDir('atc-mcp-http-');

  const caller = new TransportCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const listening = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '0.0.0.0',
    port: 0,
    publicURL: 'https://mcp.example.com',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: () => {},
  });

  registerTestCleanup(() => listening.stop());

  expect(listening.origin).toBe('https://mcp.example.com');
  expect(listening.listening).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/u);
});

test('it refuses a consent answer for a request no passkey signed in for', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const unapproved = new URL(`${ctx.url}/oauth2/authorize`);

  unapproved.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message spawn kill',
    state: 'state-attacker',
    code_challenge: createHash('sha256')
      .update('attacker-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(unapproved, { redirect: 'manual' });

  const unapprovedLogin = new URL(started.headers.get('location') ?? '/', ctx.url);
  const approved = new URL(`${ctx.url}/oauth2/authorize`);

  approved.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-operator',
    code_challenge: createHash('sha256')
      .update('operator-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(approved, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  invariant(signedIn.status === 302, 'the passkey did not sign in');

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const form = new URLSearchParams({
    oauth_query: unapprovedLogin.search.slice(1),
    decision: 'approve',
  });

  form.append('scope', 'read');
  form.append('scope', 'kill');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test("it refuses a consent answer carrying another approval's owner session", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const first = new URL(`${ctx.url}/oauth2/authorize`);

  first.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('first-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const firstStarted = await fetch(first, { redirect: 'manual' });

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', ctx.url);
  const second = new URL(`${ctx.url}/oauth2/authorize`);

  second.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read kill',
    state: 'state-2',
    code_challenge: createHash('sha256')
      .update('second-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const secondStarted = await fetch(second, { redirect: 'manual' });

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', ctx.url);

  const firstSignedIn = await runPasskeySignIn(ctx, firstLogin);
  const secondSignedIn = await runPasskeySignIn(ctx, secondLogin);

  const firstCookie = firstSignedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(firstCookie.includes('session_token='), 'the first login set no owner session');

  const secondConsent = new URL(secondSignedIn.headers.get('location') ?? '/', ctx.url);

  invariant(
    secondConsent.pathname === '/consent',
    'the second approval did not reach the consent page',
  );

  const form = new URLSearchParams({
    oauth_query: secondConsent.search.slice(1),
    decision: 'approve',
  });

  form.append('scope', 'read');
  form.append('scope', 'kill');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: ctx.url,
      cookie: firstCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it refuses a consent answer whose query still asks for a login', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  invariant(
    login.searchParams.get('prompt') === 'login consent',
    'the login query does not ask for a login',
  );

  const signedIn = await runPasskeySignIn(ctx, login);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(cookie.includes('session_token='), 'the login set no owner session');

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test("it shows an error page instead of the consent page for another approval's request", async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const first = new URL(`${ctx.url}/oauth2/authorize`);

  first.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('first-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const firstStarted = await fetch(first, { redirect: 'manual' });

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', ctx.url);
  const second = new URL(`${ctx.url}/oauth2/authorize`);

  second.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-2',
    code_challenge: createHash('sha256')
      .update('second-verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const secondStarted = await fetch(second, { redirect: 'manual' });

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', ctx.url);

  const firstSignedIn = await runPasskeySignIn(ctx, firstLogin);
  const secondSignedIn = await runPasskeySignIn(ctx, secondLogin);

  const firstCookie = firstSignedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(firstCookie.includes('session_token='), 'the first login set no owner session');

  const secondConsent = new URL(secondSignedIn.headers.get('location') ?? '/', ctx.url);

  const page = await fetch(secondConsent, { headers: { cookie: firstCookie } });
  const html = await page.text();

  expect(page.status).toBe(400);
  expect(html).toInclude('This approval expired or was already used.');
  expect(html).not.toInclude('<form');
});

test('it shows an error page instead of the consent page for a query with a broken signature', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  consent.searchParams.set('scope', 'read kill offline_access');

  const page = await fetch(consent, { headers: { cookie } });
  const html = await page.text();

  expect(page.status).toBe(400);

  expect(html).toMatchInlineSnapshot(
    `"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>atc</title></head><body><p>This approval expired or was already used. Start again from the client.</p></body></html>"`,
  );
});

test('it shows an error page instead of the consent page to a browser with no owner session', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  invariant(consent.pathname === '/consent', 'the passkey sign-in did not reach the consent page');

  const page = await fetch(consent);
  const html = await page.text();

  expect(page.status).toBe(400);

  expect(html).toMatchInlineSnapshot(
    `"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>atc</title></head><body><p>This approval expired or was already used. Start again from the client.</p></body></html>"`,
  );
});

test('it refuses a second consent answer from one login', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read kill',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const first = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  invariant(first.status === 302, 'the first consent answer was refused');

  const second = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'kill',
    }),
  });

  expect(second.status).toBe(400);
  expect(second.headers.get('location')).toBeNull();
});

test('it deletes the owner session when the operator denies the request', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const before = await ctx.store.db.selectFrom('session').select('id').execute();

  invariant(before.length === 1, 'the login left no owner session');

  const denied = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'deny' }),
  });

  const after = await ctx.store.db.selectFrom('session').select('id').execute();

  expect(denied.status).toBe(302);
  expect(after).toBeEmpty();
});

test('it keeps the owner session no longer than the authorization code it approved', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const sessions = await ctx.store.db.selectFrom('session').select('expiresAt').execute();

  const [session] = sessions;

  invariant(session !== undefined, 'the consent left no owner session');

  expect(sessions).toBeArrayOfSize(1);
  expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
});

test('it deletes the owner session once its authorization code is exchanged', async () => {
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

  invariant(exchanged.status === 200, 'the exchange failed');

  const sessions = await ctx.store.db.selectFrom('session').select('id').execute();

  expect(sessions).toBeEmpty();
});

test('it shows a fixed sentence on the error page whatever text the link carries', async () => {
  const ctx = await setupTest();

  const page = await fetch(
    `${ctx.url}/error?error=Your+atc+session+expired&error_description=Call+%2B1+555+0100+to+restore+access`,
  );

  const html = await page.text();

  expect(page.status).toBe(400);
  expect(html).toInclude('atc refused this authorization request: the request is not valid.');
  expect(html).not.toInclude('expired');
  expect(html).not.toInclude('555');
});

test('it shows the sentence for an unknown client on the error page', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'not-a-client',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });
  const page = await fetch(new URL(authorized.headers.get('location') ?? '/', ctx.url));
  const html = await page.text();

  expect(html).toInclude(
    'atc refused this authorization request: the client is not one added to atc.',
  );
});

test('it accepts a token bound to /mcp at the bare origin', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: {
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  });

  const clientID = created.clientID;

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'read',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      client_id: clientID,
      code_verifier: authorized.verifier,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const listed = await fetch(`${ctx.url}/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    }),
  });

  const body: unknown = await listed.json();

  expect(listed.status).toBe(200);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }], structuredContent: { sessions: [] } },
  });
});

test('it challenges a request to the bare origin with the /mcp resource metadata', async () => {
  const ctx = await setupTest();

  const answered = await fetch(`${ctx.url}/`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(answered.status).toBe(401);

  expect(answered.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource/mcp"`,
  );
});

test('it prints one line per request with its method, path, tool, status, time, and protocol version', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer not-a-token', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_sessions_list', arguments: {} },
    }),
  });

  expect(ctx.requests).toHaveLength(1);

  expect(ctx.requests[0]).toMatch(
    /^POST \/mcp 401 \d+ms rpc=tools\/call tool=atc_sessions_list mcp-protocol-version=2025-06-18$/u,
  );
});

test('it prints a request line without the query, the token, or the requester address', async () => {
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

  const token = String(tokens['access_token']);

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(ctx.requests).toSatisfyAll(
    (line: string) =>
      !line.includes('?') &&
      !line.includes(token) &&
      !line.includes(authorized.code) &&
      !line.includes('127.0.0.1'),
  );

  expect(ctx.requests).toIncludeAllMembers([
    expect.stringMatching(/^GET \/oauth2\/authorize 302 \d+ms$/u),
    expect.stringMatching(/^POST \/oauth2\/token 200 \d+ms$/u),
    expect.stringMatching(/^POST \/mcp 200 \d+ms rpc=ping$/u),
  ]);
});

test('it prints a refused MCP request without reading its JSON-RPC method', async () => {
  const ctx = await setupTest();

  const refused = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(refused.status).toBe(403);
  expect(ctx.requests).toHaveLength(1);
  expect(ctx.requests[0]).toMatch(/^POST \/mcp 403 \d+ms$/u);
});

test('it writes an accepted start, an owner sign-in, and an allowed consent as security events', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  expect(ctx.security).toSatisfyAll((line: string) => line.startsWith('atc security {'));

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_started',
      outcome: 'accepted',
      route: '/oauth2/authorize',
      client: { id: clientID, name: 'Claude' },
      redirectHost: 'claude.ai',
      correlationID: expect.toSatisfy((id: string) => /^[0-9a-f-]{36}$/u.test(id)),
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'owner_auth',
      outcome: 'succeeded',
      method: 'passkey',
      route: '/login',
      client: { id: clientID, name: 'Claude' },
      correlationID: expect.toSatisfy((id: string) => /^[0-9a-f-]{36}$/u.test(id)),
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'consent',
      outcome: 'allowed',
      route: '/consent',
      client: { id: clientID, name: 'Claude' },
      redirectHost: 'claude.ai',
      correlationID: expect.toSatisfy((id: string) => /^[0-9a-f-]{36}$/u.test(id)),
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it carries one correlation id from the start of an authorization through its consent', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await runMCPAuthorization(ctx, {
    clientID: created.clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const correlationIDs = ctx.security.map(
    (line) => /"correlationID":"(?<id>[^"]+)"/u.exec(line)?.groups?.['id'],
  );

  const first = correlationIDs.at(0);
  const second = correlationIDs.at(3);

  expect(correlationIDs).toStrictEqual([first, first, first, second, second, second]);
  expect(second).not.toBe(first);
});

test('it writes a start refused by the limit on starts as rate_limited', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  for (let started = 0; started < 11; started += 1) {
    await fetch(authorize, { redirect: 'manual' });
  }

  expect(ctx.security).toBeArrayOfSize(11);

  expect(JSON.parse(ctx.security.at(-1)?.slice('atc security '.length) ?? '')).toStrictEqual({
    v: 1,
    ts: new Date(ctx.clock.now()).toISOString(),
    kind: 'authorize_started',
    outcome: 'rejected',
    reason: 'rate_limited',
    route: '/oauth2/authorize',
    client: { id: clientID, name: 'Claude' },
    redirectHost: 'claude.ai',
    peer: { address: '127.0.0.1', provenance: 'socket' },
    userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
  });
});

test('it writes an authorization better-auth refuses with its error code', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://other.example/mcp',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'invalid_target',
      route: '/oauth2/authorize',
      client: { id: clientID, name: 'Claude' },
      redirectHost: 'claude.ai',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes an authorization for an unknown client as invalid_client without the client', async () => {
  const ctx = await setupTest();

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'no-such-client',
    redirect_uri: 'https://evil.example/cb',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'invalid_client',
      route: '/oauth2/authorize',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes a code exchange better-auth refuses as token_exchange with its error code', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'code-atc-never-issued-4f2a',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz',
    }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'token_exchange',
      outcome: 'rejected',
      reason: 'invalid_grant',
      route: '/oauth2/token',
      client: { id: clientID, name: 'Claude' },
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes a token exchange for an unknown client without the client', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-atc-never-issued-9d3e',
      client_id: 'no-such-client',
    }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'token_exchange',
      outcome: 'rejected',
      reason: 'invalid_grant',
      route: '/oauth2/token',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes a token exchange with a grant type atc does not offer as unsupported_grant_type', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', username: 'owner', password: 'pw-7e1c' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'token_exchange',
      outcome: 'rejected',
      reason: 'unsupported_grant_type',
      route: '/oauth2/token',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes no security event for a token exchange that issues tokens', async () => {
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

  ctx.security.length = 0;

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

  expect(exchanged.status).toBe(200);
  expect(ctx.security).toStrictEqual([]);
});

test('it writes an MCP request with a bearer token atc never issued as invalid_token', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer token-atc-never-issued-61b0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'bearer',
      outcome: 'rejected',
      reason: 'invalid_token',
      route: '/mcp',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes an MCP request whose Authorization header is not a bearer token as malformed', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Basic b3duZXI6cHctN2UxYw==' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'bearer',
      outcome: 'rejected',
      reason: 'malformed',
      route: '/mcp',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes no security event for an MCP request with no Authorization header', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(ctx.security).toStrictEqual([]);
});

test('it writes a token bound to the resource of an earlier public URL as invalid_token', async () => {
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

  const caller = new TransportCaller(ctx.socketPath, 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const security: string[] = [];

  const moved = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'http://localhost:9',
    allowedHosts: [],
    trustForwardedFrom: [],
    dbPath: ctx.dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: () => {},
    printSecurity: (line) => {
      security.push(line);
    },
  });

  registerTestCleanup(() => moved.stop());

  await fetch(`${moved.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(
    JSON.parse(`[${security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: expect.toBeString(),
      kind: 'bearer',
      outcome: 'rejected',
      reason: 'invalid_token',
      route: '/mcp',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it marks the forwarded address trusted when the socket peer is a listed proxy', async () => {
  const ctx = await setupTest();

  await ctx.restartServer(['127.0.0.1']);

  await fetch(`${ctx.url}/oauth2/authorize?client_id=no-such-client`, {
    headers: { 'cf-connecting-ip': '198.51.100.23' },
    redirect: 'manual',
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toMatchObject([
    {
      kind: 'authorize_invalid',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      forwarded: { address: '198.51.100.23', header: 'cf-connecting-ip', provenance: 'trusted' },
    },
  ]);
});

test('it marks the forwarded address unverified when the socket peer is not a listed proxy', async () => {
  const ctx = await setupTest();

  await ctx.restartServer(['192.0.2.1']);

  await fetch(`${ctx.url}/oauth2/authorize?client_id=no-such-client`, {
    headers: { 'cf-connecting-ip': '198.51.100.23' },
    redirect: 'manual',
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toMatchObject([
    {
      kind: 'authorize_invalid',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      forwarded: {
        address: '198.51.100.23',
        header: 'cf-connecting-ip',
        provenance: 'unverified',
      },
    },
  ]);
});

test('it writes a request whose Host header it does not serve as bad_host', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/.well-known/oauth-authorization-server`, {
    headers: { host: 'rebound.example' },
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_host',
      route: '/.well-known/oauth-authorization-server',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes a form post from another origin as bad_origin', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ oauth_query: 'client_id=x', credential: '{}' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_origin',
      route: '/login',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes an MCP request from a browser on another origin as bad_origin', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_origin',
      route: '/mcp',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes a sign-in posted for an approval that no longer waits as an expired owner sign-in', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: 'client_id=gone&sig=gone', credential: '{}' }),
  });

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toStrictEqual([
    {
      v: 1,
      ts: new Date(ctx.clock.now()).toISOString(),
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'expired',
      method: 'passkey',
      route: '/login',
      peer: { address: '127.0.0.1', provenance: 'socket' },
      userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
    },
  ]);
});

test('it writes no security event for the approval page itself', async () => {
  const ctx = await setupTest();

  await fetch(`${ctx.url}/login?client_id=gone&sig=gone`, { redirect: 'manual' });

  expect(ctx.security).toBeEmpty();
});

test('it writes an allow sent with no scope ticked as a denied consent with none_ticked', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' }),
  });

  expect(JSON.parse(ctx.security.at(-1)?.slice('atc security '.length) ?? '')).toStrictEqual({
    v: 1,
    ts: new Date(ctx.clock.now()).toISOString(),
    kind: 'consent',
    outcome: 'denied',
    reason: 'none_ticked',
    route: '/consent',
    client: { id: clientID, name: 'Claude' },
    redirectHost: 'claude.ai',
    correlationID: expect.toSatisfy((id: string) => /^[0-9a-f-]{36}$/u.test(id)),
    peer: { address: '127.0.0.1', provenance: 'socket' },
    userAgent: { summary: expect.toStartWith('Bun/'), provenance: 'client' },
  });
});

test('it writes a deny as a denied consent with no reason', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'deny',
      scope: 'read',
    }),
  });

  expect(JSON.parse(ctx.security.at(-1)?.slice('atc security '.length) ?? '')).toMatchObject({
    kind: 'consent',
    outcome: 'denied',
  });

  expect(ctx.security.at(-1)).not.toInclude('"reason"');
});

test('it writes one suppressed event with the dropped count once a burst past the cap ends its minute', async () => {
  const ctx = await setupTest();

  for (let sent = 0; sent < 26; sent += 1) {
    await fetch(`${ctx.url}/mcp`, { method: 'POST', headers: { host: 'rebound.example' } });
  }

  ctx.clock.advance(60_000);

  expect(ctx.security).toBeArrayOfSize(21);
  expect(ctx.security.slice(0, 20)).toSatisfyAll((line: string) => line.includes('"bad_host"'));

  expect(JSON.parse(ctx.security[20]?.slice('atc security '.length) ?? '')).toStrictEqual({
    v: 1,
    ts: new Date(ctx.clock.now()).toISOString(),
    kind: 'suppressed',
    reason: 'authorize_invalid',
    count: 6,
  });
});

test('it marks every forwarded address unverified and keeps every secret of a full sign-in and its refused tokens out of its events and request lines', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const clientID = created.clientID;

  // Every request carries a forwarded address, a cookie, and a bearer token
  // of its own that no event may hold.
  const sent = {
    'cf-connecting-ip': '198.51.100.23',
    cookie: 'canary_cookie=canary-cookie-value-5e1d',
    authorization: 'Bearer canary-bearer-value-77ab',
  };

  const verifier = 'canary-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'canary-state-value-3c9f',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ctx.origin}/mcp`,
    canary_secret: 'canary-query-secret-a41c',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual', headers: sent });

  const login = new URL(authorized.headers.get('location') ?? '/', ctx.url);

  const firstPage = await fetch(new URL(`${login.pathname}${login.search}`, ctx.url), {
    headers: sent,
  });

  const firstHTML = await firstPage.text();

  const firstCeremony = parsePasskeyPage(firstHTML);

  invariant(firstCeremony.mode === 'get', 'the login page asked to enroll');

  const wrong = await ctx.authenticator.get(firstCeremony.options, {
    origin: 'https://canary-wrong-origin.example',
  });

  await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...sent, origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(wrong),
    }),
  });

  const secondPage = await fetch(new URL(`${login.pathname}${login.search}`, ctx.url), {
    headers: sent,
  });

  const secondHTML = await secondPage.text();

  const secondCeremony = parsePasskeyPage(secondHTML);

  invariant(secondCeremony.mode === 'get', 'the login page asked to enroll');

  const right = await ctx.authenticator.get(secondCeremony.options, { origin: ctx.origin });

  const signedIn = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...sent, origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(right),
    }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const sessionCookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  await fetch(consent, {
    redirect: 'manual',
    headers: { ...sent, cookie: sessionCookie },
  });

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...sent,
      origin: ctx.url,
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  const callback = new URL(consented.headers.get('location') ?? '/');

  const code = callback.searchParams.get('code');

  invariant(code !== null, `no authorization code in: ${callback.href}`);

  const exchanged = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': sent['cf-connecting-ip'] },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: verifier,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const accessToken = tokens['access_token'];
  const refreshToken = tokens['refresh_token'];

  invariant(typeof accessToken === 'string' && typeof refreshToken === 'string', 'no tokens');

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': sent['cf-connecting-ip'] },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientID,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  const rotated = await readJSONRecord(refreshed);

  const rotatedAccess = rotated['access_token'];
  const rotatedRefresh = rotated['refresh_token'];

  invariant(typeof rotatedAccess === 'string' && typeof rotatedRefresh === 'string', 'no refresh');

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      'cf-connecting-ip': sent['cf-connecting-ip'],
      authorization: `Bearer ${rotatedAccess}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  // The refused token requests carry the spent code and refresh token with no
  // Authorization header, which better-auth reads as client authentication,
  // then the canary bearer token and a header that is no bearer token.
  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': sent['cf-connecting-ip'], cookie: sent.cookie },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: verifier,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': sent['cf-connecting-ip'], cookie: sent.cookie },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientID,
      resource: `${ctx.origin}/mcp`,
    }),
  });

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { ...sent, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      ...sent,
      authorization: 'Basic canary-basic-value-2d8e',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  // The refusals carry the same secrets: an authorization for another
  // resource, a request to a Host atc does not serve, and a consent form
  // from another origin.
  const invalid = new URL(authorize);

  invalid.searchParams.set('resource', 'https://other.example/mcp');

  await fetch(invalid, { redirect: 'manual', headers: sent });

  await fetch(`${ctx.url}/mcp?canary_secret=canary-query-secret-a41c`, {
    method: 'POST',
    headers: { ...sent, host: 'rebound.example' },
  });

  await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...sent,
      origin: 'https://evil.example',
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' }),
  });

  const secrets = [
    rotatedAccess,
    rotatedRefresh,
    sent.cookie,
    'canary-cookie-value-5e1d',
    'canary-bearer-value-77ab',
    'canary-basic-value-2d8e',
    verifier,
    challenge,
    'canary-state-value-3c9f',
    'canary-query-secret-a41c',
    firstCeremony.options.challenge,
    secondCeremony.options.challenge,
    JSON.stringify(wrong),
    wrong.response.signature,
    wrong.response.clientDataJSON,
    JSON.stringify(right),
    right.response.signature,
    right.response.clientDataJSON,
    right.response.authenticatorData,
    login.search.slice(1),
    login.searchParams.get('sig') ?? 'no-sig',
    consent.search.slice(1),
    consent.searchParams.get('sig') ?? 'no-sig',
    sessionCookie,
    sessionCookie.split('=').slice(1).join('='),
    code,
    accessToken,
    refreshToken,
  ];

  const forwarded = {
    address: '198.51.100.23',
    header: 'cf-connecting-ip',
    provenance: 'unverified',
  };

  expect(
    JSON.parse(`[${ctx.security.map((line) => line.slice('atc security '.length)).join(',')}]`),
  ).toMatchObject([
    { kind: 'authorize_started', forwarded },
    { kind: 'owner_auth', forwarded },
    { kind: 'owner_auth', forwarded },
    { kind: 'consent', forwarded },
    { kind: 'token_exchange', reason: 'invalid_grant', forwarded },
    { kind: 'token_exchange', reason: 'invalid_grant', forwarded },
    { kind: 'bearer', reason: 'invalid_token', forwarded },
    { kind: 'bearer', reason: 'malformed', forwarded },
    { kind: 'authorize_invalid', forwarded },
    { kind: 'authorize_invalid', forwarded },
    { kind: 'authorize_invalid', forwarded },
  ]);

  expect([...ctx.security, ...ctx.requests]).toSatisfyAll((line: string) =>
    secrets.every((secret) => !line.includes(secret)),
  );
});

test('it refreshes a grant issued before a restart', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
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
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await ctx.restartServer();

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    // A fresh connection, since the restart closed the pooled one.
    keepalive: false,
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: created.clientID,
    }),
  });

  expect(refreshed.status).toBe(200);

  const body = await readJSONRecord(refreshed);

  expect(body).toMatchObject({ scope: 'read offline_access' });
});

test('it serves an MCP request with an access token issued before a restart', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
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
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await ctx.restartServer();

  const pinged = await fetch(`${ctx.url}/mcp`, {
    // A fresh connection, since the restart closed the pooled one.
    keepalive: false,
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it refuses the refresh token of a grant revoked before a restart', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
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
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);
  const [grant] = await collectGrants(ctx.store.db);

  invariant(grant !== undefined, 'the exchange left no grant');

  await revokeGrant(ctx.store.db, grant.grantID);

  await ctx.restartServer();

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    // A fresh connection, since the restart closed the pooled one.
    keepalive: false,
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: created.clientID,
    }),
  });

  expect(refreshed.status).toBe(400);
});

test('it refuses a consent answer from a sign-in made before a restart', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(consent.pathname === '/consent', 'the passkey sign-in did not reach the consent page');

  await ctx.restartServer();

  const consented = await fetch(`${ctx.url}/consent`, {
    // A fresh connection, since the restart closed the pooled one.
    keepalive: false,
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it refuses a login page opened before a restart', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  await ctx.restartServer();

  const signedIn = await fetch(`${ctx.url}/login`, {
    // A fresh connection, since the restart closed the pooled one.
    keepalive: false,
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(signedIn.status).toBe(400);
  expect(signedIn.headers.getSetCookie()).toBeEmpty();
});

test('it refuses a consent answer from a sign-in made before the passkeys were reset', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', ctx.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  invariant(consent.pathname === '/consent', 'the passkey sign-in did not reach the consent page');

  await resetPasskeys(ctx.store.db);

  const consented = await fetch(`${ctx.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it refuses the lost passkey once a reset enrolled a new one', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  await resetPasskeys(ctx.store.db);

  const enrollment = await createEnrollmentToken(ctx.store.db, ctx.clock.now());

  await runPasskeyEnrollment(ctx, enrollment.token, buildStubAuthenticator());

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const signedIn = await runPasskeySignIn(ctx, login);

  expect(signedIn.status).toBe(400);
  expect(signedIn.headers.getSetCookie()).toBeEmpty();
});

test('it refuses a sign-in abandoned at the passkey prompt once its approval expired', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorize = new URL(`${ctx.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const started = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(started.headers.get('location') ?? '/', ctx.url);

  const loginPage = await fetch(login);
  const loginHTML = await loginPage.text();

  const ceremony = parsePasskeyPage(loginHTML);

  invariant(ceremony.mode === 'get', 'the login page asked to enroll');

  const assertion = await ctx.authenticator.get(ceremony.options, { origin: ctx.origin });

  ctx.clock.advance(600_000);

  const signedIn = await fetch(`${ctx.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ctx.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });

  expect(signedIn.status).toBe(400);
  expect(signedIn.headers.getSetCookie()).toBeEmpty();
});

test('it refreshes a grant issued before the passkeys were reset', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const authorized = await runMCPAuthorization(ctx, {
    clientID: created.clientID,
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
      client_id: created.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await resetPasskeys(ctx.store.db);

  const refreshed = await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: created.clientID,
    }),
  });

  expect(refreshed.status).toBe(200);
});
