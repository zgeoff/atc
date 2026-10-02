import { expect, onTestFinished, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJSONRecord } from '../../test/read-json-record';
import { runMCPAuthorization } from '../../test/run-mcp-authorization';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectGrants } from './collect-grants';
import { ReconnectingCaller } from './reconnecting-caller';
import { removeClient } from './remove-client';
import { revokeGrant } from './revoke-grant';
import { startMCPHTTPServer } from './start-mcp-http-server';

test('it advertises public clients with PKCE, issuer responses, and no registration', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
  const metadata = await readJSONRecord(answered);

  expect(metadata).toMatchObject({
    issuer: server.origin,
    authorization_endpoint: `${server.origin}/oauth2/authorize`,
    token_endpoint: `${server.origin}/oauth2/token`,
    revocation_endpoint: `${server.origin}/oauth2/revoke`,
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
});

test.each([
  ['/.well-known/oauth-protected-resource'],
  ['/.well-known/oauth-protected-resource/mcp'],
])('it serves the protected resource metadata at %p', async (path) => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}${path}`);
  const metadata = await readJSONRecord(answered);

  expect(metadata).toMatchObject({
    resource: `${server.origin}/mcp`,
    authorization_servers: [server.origin],
    scopes_supported: ['read', 'message', 'spawn', 'kill'],
  });
});

test('it challenges a request without a token with where to find the resource metadata', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(answered.status).toBe(401);

  expect(answered.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp"`,
  );
});

test('it issues an access and refresh token for an approved authorization code', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message kill',
    ticked: ['read', 'kill'],
  });

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
      resource: `${server.origin}/mcp`,
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
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
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
    iss: server.origin,
  });
});

test('it prints the client name, the host it returns to, the approval code, and the requester', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  expect(server.approvals).toBeArrayOfSize(1);

  expect(server.approvals[0]).toMatch(
    /^Approve Claude \(returns to claude\.ai\) with code [0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\. Requested from 127\.0\.0\.1, user agent "Bun\/[^"]+"\. The code expires in 10 minutes\.$/,
  );
});

test('it runs a tool call whose scope the token holds', async () => {
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
      params: { name: 'atc_session_list', arguments: {} },
    }),
  });

  const body: unknown = await listed.json();

  expect(listed.status).toBe(200);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }] },
  });
});

test('it refuses a tool call for a scope the operator left unticked with insufficient_scope', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read spawn',
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

  const spawned = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens['access_token'])}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_session_spawn', arguments: { cwd: '/tmp' } },
    }),
  });

  const body: unknown = await spawned.json();

  expect(tokens['scope']).toBe('read offline_access');
  expect(spawned.status).toBe(403);

  expect(spawned.headers.get('www-authenticate')).toBe(
    `Bearer error="insufficient_scope", scope="spawn", resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp"`,
  );

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32_001, message: 'this grant lacks the spawn scope' },
  });
});

test('it refuses consent to a scope the client did not request', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const form = new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' });

  form.append('scope', 'read');
  form.append('scope', 'kill');

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  expect(consent.pathname).toBe('/consent');
  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it denies the request when the operator allows nothing', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' }),
  });

  const callback = new URL(consented.headers.get('location') ?? '/', server.url);

  expect(`${callback.origin}${callback.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(callback.searchParams)).toStrictEqual({
    error: 'access_denied',
    error_description: 'User denied access',
    state: 'state-1',
    iss: server.origin,
  });

  expect(consented.headers.get('set-cookie')).toMatch(/session_token=; Max-Age=0;/);
});

test('it shows the consent page on every authorization of a client', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const first = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const second = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  expect(second.code).not.toBe(first.code);
});

test('it binds a token to /mcp when the client names no resource', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const verifier = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  const callback = new URL(consented.headers.get('location') ?? '/', server.url);

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
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

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it prints a client name with its control characters dropped', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Evil\u001B[2J\nName\u202E', ['https://evil.example/cb']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://evil.example/cb',
    scope: 'read',
    code_challenge: createHash('sha256')
      .update('verifier-0123456789-abcdefghijklmnopqrstuvwxyz')
      .digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  expect(server.approvals[0]).toStartWith(
    'Approve Evil[2J Name (returns to evil.example) with code ',
  );
});

test('it asks a browser that kept its owner session for a fresh approval code', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(first.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const second = await fetch(authorize, { redirect: 'manual', headers: { cookie } });

  const next = new URL(second.headers.get('location') ?? '/', server.url);

  expect(cookie).toInclude('session_token=');
  expect(next.pathname).toBe('/login');
  expect(server.approvals).toBeArrayOfSize(2);
});

test('it refuses an access token once its grant is revoked', async () => {
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
  const [grant] = await collectGrants(server.store.db);

  if (grant === undefined) {
    throw new Error('the exchange left no grant');
  }

  const before = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  await revokeGrant(server.store.db, grant.grantID);

  const after = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  const refreshed = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(before.status).toBe(200);
  expect(after.status).toBe(401);
  expect(refreshed.status).toBe(400);
});

test('it shows the consent page again to a client whose grant was revoked', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const [grant] = await collectGrants(server.store.db);

  if (grant === undefined) {
    throw new Error('the exchange left no grant');
  }

  await revokeGrant(server.store.db, grant.grantID);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(again.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const next = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const page = await fetch(next, { headers: { cookie } });
  const html = await page.text();

  expect(next.pathname).toBe('/consent');
  expect(html).toInclude('value="read" checked');
});

test('it rotates a refresh token and refuses the spent one with the rest of its family', async () => {
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

  const first = await readJSONRecord(exchanged);

  const rotated = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  const second = await readJSONRecord(rotated);

  const replayed = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: clientID,
    }),
  });

  const replay = await readJSONRecord(replayed);

  const successor = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(second['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(rotated.status).toBe(200);
  expect(second['refresh_token']).not.toBe(first['refresh_token']);
  expect(second['scope']).toBe('read offline_access');
  expect(replayed.status).toBe(400);

  expect(replay).toStrictEqual({
    error: 'invalid_grant',
    error_description: 'invalid refresh token',
  });

  expect(successor.status).toBe(400);
});

test('it refuses a reused authorization code and revokes what the first use issued', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
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

  const first = await fetch(`${server.url}/oauth2/token`, { method: 'POST', body: exchange });
  const tokens = await readJSONRecord(first);
  const second = await fetch(`${server.url}/oauth2/token`, { method: 'POST', body: exchange });
  const refusal = await readJSONRecord(second);

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(first.status).toBe(200);
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
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const location = new URL(answered.headers.get('location') ?? '/', server.url);

  expect(`${location.origin}${location.pathname}`).toBe(`${server.origin}/error`);
  expect(server.approvals).toBeEmpty();
});

test('it refuses an authorization for another resource with invalid_target', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const location = new URL(answered.headers.get('location') ?? '/', server.url);

  expect(`${location.origin}${location.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    error: 'invalid_target',
    error_description: 'requested resource https://other.example/mcp is not configured',
    state: 'state-1',
    iss: server.origin,
  });

  expect(server.approvals).toBeEmpty();
});

test('it refuses a code exchange for another resource with invalid_target', async () => {
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
      resource: 'https://other.example/mcp',
    }),
  });

  const refusal = await readJSONRecord(exchanged);

  expect(exchanged.status).toBe(400);
  expect(refusal).toMatchObject({ error: 'invalid_target' });
});

test('it refuses an authorization without PKCE before asking the operator', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    state: 'state-1',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  const location = new URL(answered.headers.get('location') ?? '/', server.url);

  expect(`${location.origin}${location.pathname}`).toBe('https://claude.ai/api/mcp/auth_callback');

  expect(Object.fromEntries(location.searchParams)).toMatchObject({
    error: 'invalid_request',
    state: 'state-1',
    iss: server.origin,
  });

  expect(server.approvals).toBeEmpty();
});

test('it refuses a code exchange with the wrong PKCE verifier', async () => {
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

test('it shows the approval page again with an error after a wrong code', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const wrong = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: 'WRONG-CODE' }),
  });

  const html = await wrong.text();

  expect(wrong.status).toBe(400);
  expect(wrong.headers.getSetCookie()).toBeEmpty();
  expect(html).toInclude('That approval code is wrong.');
});

test('it refuses the right approval code after five wrong ones', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const misses = [];

  for (const attempt of [1, 2, 3, 4, 5]) {
    const missed = await fetch(`${server.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        oauth_query: login.search.slice(1),
        code: `WRONG-000${attempt}`,
      }),
    });

    misses.push(missed.status);
  }

  const right = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const html = await right.text();

  expect(misses).toStrictEqual([400, 400, 400, 400, 400]);
  expect(right.status).toBe(400);
  expect(right.headers.get('location')).toBeNull();
  expect(html).toInclude('This approval expired or was already used.');
});

test('it refuses an eleventh authorization started within a minute', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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
  expect(server.approvals).toBeArrayOfSize(10);
});

test("it ends a client's oldest approval when the client starts a fourth", async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const logins = [];

  for (let started = 0; started < 4; started += 1) {
    const answered = await fetch(authorize, { redirect: 'manual' });

    logins.push(new URL(answered.headers.get('location') ?? '/', server.url));
  }

  const pages = [];

  for (const login of logins) {
    const page = await fetch(login);

    pages.push(page.status);
  }

  expect(pages).toStrictEqual([400, 200, 200, 200]);
});

test('it refuses a request whose Host header it does not serve', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/.well-known/oauth-authorization-server`, {
    headers: { host: 'rebound.example' },
  });

  expect(answered.status).toBe(403);
});

test('it serves a request whose Host header is a configured allowed host', async () => {
  await using server = await setupMCPHTTP({ allowedHosts: ['pc.tailnet.example'] });

  const answered = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`, {
    headers: { host: 'pc.tailnet.example' },
  });

  expect(answered.status).toBe(200);
});

test.each([
  ['/login', 'https://attacker.example'],
  ['/login', null],
  ['/consent', 'https://attacker.example'],
  ['/consent', null],
])('it refuses a form post to %p from origin %p', async (path, origin) => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { origin }),
    },
    body: 'oauth_query=a&code=b',
  });

  expect(answered.status).toBe(403);
});

test('it refuses an MCP request from a browser on another origin', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(answered.status).toBe(403);
});

test('it sends its pages with headers that keep them out of frames and caches', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/login?unknown=1`);

  expect(answered.headers.get('content-security-policy')).toInclude("frame-ancestors 'none'");
  expect(answered.headers.get('x-frame-options')).toBe('DENY');
  expect(answered.headers.get('cache-control')).toBe('no-store');
  expect(answered.headers.get('referrer-policy')).toBe('same-origin');
});

test.each([
  ['POST', '/oauth2/create-client'],
  ['POST', '/oauth2/register'],
  ['POST', '/oauth2/introspect'],
  ['GET', '/oauth2/get-clients'],
  ['GET', '/list-sessions'],
  ['POST', '/sign-up/email'],
  ['POST', '/atc/sign-in-owner'],
])('it answers %s %p with 404', async (method, path) => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}${path}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
  });

  expect(answered.status).toBe(404);
});

test('it keeps serving a token after the session that approved it expires', async () => {
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

  await server.store.db
    .updateTable('session')
    .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
    .execute();

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const refreshed = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  const fresh = await readJSONRecord(refreshed);

  const pingedAgain = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(fresh['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
  expect(refreshed.status).toBe(200);
  expect(pingedAgain.status).toBe(200);
});

test('it refuses the tokens of a removed client', async () => {
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
  const removed = await removeClient(server.store.db, clientID);

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const refreshed = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(tokens['refresh_token']),
      client_id: clientID,
    }),
  });

  expect(removed).toBeTrue();
  expect(pinged.status).toBe(401);
  expect(refreshed.status).toBe(400);
});

test('it refuses a token bound to the resource of an earlier public URL', async () => {
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

  const caller = new ReconnectingCaller(join(server.home, 'daemon.sock'), 'atc/test-build');

  const moved = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: 'http://localhost:9',
    allowedHosts: [],
    dbPath: server.dbPath,
    printApproval: () => {},
  });

  onTestFinished(async () => {
    await moved.stop();
    await caller.stop();
  });

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
  using tmp = setupTempDir('atc-mcp-http-');

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build');

  onTestFinished(async () => {
    await caller.stop();
  });

  const started = startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host,
    port: 0,
    publicURL,
    allowedHosts: [],
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    printApproval: () => {},
  });

  expect(started).rejects.toThrow(/needs an https public URL/);
});

test('it listens beyond loopback behind an https public URL', async () => {
  using tmp = setupTempDir('atc-mcp-http-');

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build');

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '0.0.0.0',
    port: 0,
    publicURL: 'https://mcp.example.com',
    allowedHosts: [],
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    printApproval: () => {},
  });

  onTestFinished(async () => {
    await server.stop();
    await caller.stop();
  });

  expect(server.origin).toBe('https://mcp.example.com');
});

test('it refuses a consent answer for a request whose approval code was never typed', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const unapproved = new URL(`${server.url}/oauth2/authorize`);

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

  const unapprovedLogin = new URL(started.headers.get('location') ?? '/', server.url);
  const approved = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

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

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  expect(signedIn.status).toBe(302);
  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test("it refuses a consent answer carrying another approval's owner session", async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const first = new URL(`${server.url}/oauth2/authorize`);

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

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', server.url);

  const firstCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const second = new URL(`${server.url}/oauth2/authorize`);

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

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', server.url);

  const secondCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const firstSignedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: firstLogin.search.slice(1), code: firstCode ?? '' }),
  });

  const secondSignedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: secondLogin.search.slice(1), code: secondCode ?? '' }),
  });

  const firstCookie = firstSignedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const secondConsent = new URL(secondSignedIn.headers.get('location') ?? '/', server.url);

  const form = new URLSearchParams({
    oauth_query: secondConsent.search.slice(1),
    decision: 'approve',
  });

  form.append('scope', 'read');
  form.append('scope', 'kill');

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: server.url,
      cookie: firstCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  expect(secondConsent.pathname).toBe('/consent');
  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test('it refuses a consent answer whose query still asks for a login', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  expect(login.searchParams.get('prompt')).toBe('login consent');
  expect(consented.status).toBe(400);
  expect(consented.headers.get('location')).toBeNull();
});

test("it shows an error page instead of the consent page for another approval's request", async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const first = new URL(`${server.url}/oauth2/authorize`);

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

  const firstLogin = new URL(firstStarted.headers.get('location') ?? '/', server.url);

  const firstCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const second = new URL(`${server.url}/oauth2/authorize`);

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

  const secondLogin = new URL(secondStarted.headers.get('location') ?? '/', server.url);

  const secondCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const firstSignedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: firstLogin.search.slice(1), code: firstCode ?? '' }),
  });

  const secondSignedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: secondLogin.search.slice(1), code: secondCode ?? '' }),
  });

  const firstCookie = firstSignedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const secondConsent = new URL(secondSignedIn.headers.get('location') ?? '/', server.url);

  const page = await fetch(secondConsent, { headers: { cookie: firstCookie } });
  const html = await page.text();

  expect(page.status).toBe(400);
  expect(html).toInclude('This approval expired or was already used.');
  expect(html).not.toInclude('<form');
});

test('it shows an error page instead of the consent page for a query with a broken signature', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  consent.searchParams.set('scope', 'read kill offline_access');

  const page = await fetch(consent, { headers: { cookie } });
  const html = await page.text();

  expect(page.status).toBe(400);
  expect(html).not.toInclude('Kill sessions');
});

test('it shows an error page instead of the consent page to a browser with no owner session', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const page = await fetch(consent);

  expect(consent.pathname).toBe('/consent');
  expect(page.status).toBe(400);
});

test('it refuses a second consent answer from one login', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const first = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'read',
    }),
  });

  const second = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: consent.search.slice(1),
      decision: 'approve',
      scope: 'kill',
    }),
  });

  expect(first.status).toBe(302);
  expect(second.status).toBe(400);
  expect(second.headers.get('location')).toBeNull();
});

test('it deletes the owner session when the operator denies the request', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  const signedIn = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: login.search.slice(1), code: approvalCode ?? '' }),
  });

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const before = await server.store.db.selectFrom('session').select('id').execute();

  const denied = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'deny' }),
  });

  const after = await server.store.db.selectFrom('session').select('id').execute();

  expect(before).toBeArrayOfSize(1);
  expect(denied.status).toBe(302);
  expect(after).toBeEmpty();
});

test('it keeps the owner session no longer than the authorization code it approved', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  const sessions = await server.store.db.selectFrom('session').select('expiresAt').execute();

  const [session] = sessions;

  if (session === undefined) {
    throw new Error('the consent left no owner session');
  }

  expect(sessions).toBeArrayOfSize(1);
  expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
});

test('it deletes the owner session once its authorization code is exchanged', async () => {
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

  const sessions = await server.store.db.selectFrom('session').select('id').execute();

  expect(exchanged.status).toBe(200);
  expect(sessions).toBeEmpty();
});

test('it prints the CF-Connecting-IP address as reported when the request carries one', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  await fetch(authorize, {
    redirect: 'manual',
    headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Claude-User/1.0' },
  });

  expect(server.approvals).toBeArrayOfSize(1);

  expect(server.approvals[0]).toInclude(
    '. Requested from 203.0.113.7 (reported by CF-Connecting-IP), user agent "Claude-User/1.0". ',
  );
});

test('it prints the requester with control characters dropped and the user agent cut to 60 characters', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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

  await fetch(authorize, {
    redirect: 'manual',
    headers: {
      'cf-connecting-ip': '203.0.113.7\u007F',
      'user-agent': `Evil\u007F\tUA ${'A'.repeat(100)}`,
    },
  });

  expect(server.approvals).toBeArrayOfSize(1);

  expect(server.approvals[0]).toInclude(
    `. Requested from 203.0.113.7 (reported by CF-Connecting-IP), user agent "Evil UA ${'A'.repeat(52)}". `,
  );
});

test('it shows a fixed sentence on the error page whatever text the link carries', async () => {
  await using server = await setupMCPHTTP();

  const page = await fetch(
    `${server.url}/error?error=Your+atc+session+expired&error_description=Call+%2B1+555+0100+to+restore+access`,
  );

  const html = await page.text();

  expect(page.status).toBe(400);
  expect(html).toInclude('atc refused this authorization request: the request is not valid.');
  expect(html).not.toInclude('expired');
  expect(html).not.toInclude('555');
});

test('it shows the sentence for an unknown client on the error page', async () => {
  await using server = await setupMCPHTTP();

  const authorize = new URL(`${server.url}/oauth2/authorize`);

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
  const page = await fetch(new URL(authorized.headers.get('location') ?? '/', server.url));
  const html = await page.text();

  expect(html).toInclude(
    'atc refused this authorization request: the client is not one added to atc.',
  );
});
