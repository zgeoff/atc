import { expect, test } from 'bun:test';
import { readJSONRecord } from '../../test/read-json-record';
import { runMCPAuthorization } from '../../test/run-mcp-authorization';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { isRecord } from '../shared/report';

test('it grants a client scoped access to the mcp tools until the grant is revoked', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read', 'message']);

  const exchanged = await fetch(`${server.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: authorized.redirectURI,
      client_id: authorized.clientID,
      code_verifier: authorized.verifier,
      resource: `${server.origin}/mcp`,
    }).toString(),
  });

  const tokens = await readJSONRecord(exchanged);

  const bearer = `Bearer ${String(tokens['access_token'])}`;

  const listed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atc_session_list', arguments: {} },
    }),
  });

  const killed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atc_session_kill', arguments: { session: 's1' } },
    }),
  });

  const grants = await server.caller.sendRequest('grant.list');

  const listedGrants = grants['grants'];

  if (!Array.isArray(listedGrants)) {
    throw new TypeError('grant.list returned no grants');
  }

  const grantList: readonly unknown[] = listedGrants;
  const [firstGrant] = grantList;

  if (!isRecord(firstGrant)) {
    throw new TypeError('grant.list returned an empty list');
  }

  const grantID = firstGrant['id'];

  await server.caller.sendRequest('grant.revoke', { grant: grantID });

  const afterRevoke = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  });

  expect(exchanged.status).toBe(200);

  expect(tokens).toStrictEqual({
    access_token: expect.stringMatching(/^atc_at_/),
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: expect.stringMatching(/^atc_rt_/),
    scope: 'read message',
  });

  const listedBody: unknown = await listed.json();

  expect(listed.status).toBe(200);

  expect(listedBody).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }] },
  });

  expect(killed.status).toBe(403);

  expect(killed.headers.get('www-authenticate')).toStartWith(
    'Bearer error="insufficient_scope", scope="kill"',
  );

  expect(afterRevoke.status).toBe(401);
});

test('it rotates a refresh token into a working access token', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read']);

  const exchanged = await fetch(`${server.url}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: authorized.redirectURI,
      client_id: authorized.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const first = await readJSONRecord(exchanged);

  const refreshed = await fetch(`${server.url}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(first['refresh_token']),
      client_id: authorized.clientID,
    }),
  });

  const second = await readJSONRecord(refreshed);

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(second['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(second).toMatchObject({ token_type: 'Bearer', scope: 'read' });
  expect(second['refresh_token']).not.toBe(first['refresh_token']);
  expect(pinged.status).toBe(200);
});

test('it revokes the grant when an authorization code is exchanged twice', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read']);

  const exchange = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorized.code,
    redirect_uri: authorized.redirectURI,
    client_id: authorized.clientID,
    code_verifier: authorized.verifier,
  });

  const first = await fetch(`${server.url}/token`, { method: 'POST', body: exchange });
  const tokens = await readJSONRecord(first);
  const second = await fetch(`${server.url}/token`, { method: 'POST', body: exchange });

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const refusal: unknown = await second.json();

  expect(second.status).toBe(400);
  expect(refusal).toMatchObject({ error: 'invalid_grant' });
  expect(pinged.status).toBe(401);
});

test('it refuses a code exchange whose verifier does not match the challenge', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read']);

  const exchanged = await fetch(`${server.url}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: authorized.redirectURI,
      client_id: authorized.clientID,
      code_verifier: 'a-different-verifier-that-is-long-enough-0123456789',
    }),
  });

  const refusal: unknown = await exchanged.json();

  expect(exchanged.status).toBe(400);
  expect(refusal).toMatchObject({ error: 'invalid_grant' });
});

test('it ends an approval after five wrong approval codes', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'dots', redirect_uris: ['https://dots.example/cb'] }),
  });

  const registration = await readJSONRecord(registered);

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(registration['client_id']),
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const consent = await fetch(authorize);
  const page = await consent.text();

  const pendingID = /name="pending" value="(?<id>[^"]+)"/.exec(page)?.groups?.['id'];

  if (pendingID === undefined) {
    throw new Error('consent page holds no pending approval');
  }

  const wrong = new URLSearchParams({ pending: pendingID, code: 'ZZZZ-ZZZZ', decision: 'approve' });

  const statuses: number[] = [];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const answered = await fetch(`${server.url}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
      body: wrong.toString(),
    });

    statuses.push(answered.status);

    await answered.text();
  }

  expect(statuses).toStrictEqual([400, 400, 400, 400, 400, 400]);
  expect(server.approvals).toBeArrayOfSize(1);
});

test('it prints a self-registered client as unverified with the host it returns to', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'dots', redirect_uris: ['https://dots.example/cb'] }),
  });

  const registration = await readJSONRecord(registered);

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(registration['client_id']),
    redirect_uri: 'https://dots.example/cb',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const answered = await fetch(authorize);

  await answered.text();

  const [line] = server.approvals;

  expect(server.approvals).toBeArrayOfSize(1);

  expect(line).toMatch(
    /^Approve dots \(unverified, registered itself; returns to dots\.example\) with code \w{4}-\w{4}\./,
  );
});

test('it never redirects an authorization request to an unregistered redirect URI', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'dots', redirect_uris: ['https://dots.example/cb'] }),
  });

  const registration = await readJSONRecord(registered);

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(registration['client_id']),
    redirect_uri: 'https://evil.example/cb',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  expect(answered.status).toBe(400);
  expect(answered.headers.get('location')).toBeNull();
});

test('it redirects an authorization request without PKCE back with an error and the issuer', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'dots', redirect_uris: ['https://dots.example/cb'] }),
  });

  const registration = await readJSONRecord(registered);

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(registration['client_id']),
    state: 'abc',
  }).toString();

  const answered = await fetch(authorize, { redirect: 'manual' });

  const location = new URL(answered.headers.get('location') ?? 'https://missing.example');

  expect(answered.status).toBe(302);

  expect(Object.fromEntries(location.searchParams)).toMatchObject({
    error: 'invalid_request',
    state: 'abc',
    iss: server.origin,
  });
});

test('it refuses an approval posted from another origin', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/authorize`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'pending=x&code=ABCD-EFGH&decision=approve',
  });

  expect(answered.status).toBe(403);
});

test('it asks for a token with a pointer to the resource metadata', async () => {
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

test('it answers an unsupported mcp protocol version with an empty 400', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const body = await answered.text();

  expect(answered.status).toBe(400);
  expect(body).toBe('');
});

test('it refuses a GET on the mcp endpoint', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/mcp`);

  expect(answered.status).toBe(405);
  expect(answered.headers.get('allow')).toBe('POST');
});

test('it refuses a request whose Host header it does not serve', async () => {
  await using server = await setupMCPHTTP();

  const answered = await fetch(`${server.url}/.well-known/oauth-authorization-server`, {
    headers: { host: 'rebound.example' },
  });

  expect(answered.status).toBe(403);
});

test('it serves the protected resource metadata at both well-known paths', async () => {
  await using server = await setupMCPHTTP();

  const bare = await fetch(`${server.url}/.well-known/oauth-protected-resource`);
  const scoped = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`);
  const bareMetadata: unknown = await bare.json();
  const scopedMetadata: unknown = await scoped.json();

  expect(bareMetadata).toStrictEqual(scopedMetadata);
});

test('it keeps serving after the daemon restarts', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read']);

  const exchanged = await fetch(`${server.url}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: authorized.redirectURI,
      client_id: authorized.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  await server.restartDaemon();

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(pinged.status).toBe(200);
});

test('it registers a client listing five redirect URIs', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({
      client_name: 'dots',
      redirect_uris: [1, 2, 3, 4, 5].map((n) => `https://dots.example/cb${n}`),
    }),
  });

  expect(registered.status).toBe(201);
});

test('it refuses a registration listing more than five redirect URIs', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({
      client_name: 'dots',
      redirect_uris: [1, 2, 3, 4, 5, 6].map((n) => `https://dots.example/cb${n}`),
    }),
  });

  const refusal = await readJSONRecord(registered);

  expect(registered.status).toBe(400);
  expect(refusal).toMatchObject({ error: 'invalid_redirect_uri' });
});

test('it refuses a registration with a redirect URI longer than 2000 characters', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({
      client_name: 'dots',
      redirect_uris: [`https://dots.example/${'x'.repeat(2000)}`],
    }),
  });

  const refusal = await readJSONRecord(registered);

  expect(registered.status).toBe(400);
  expect(refusal).toMatchObject({ error: 'invalid_redirect_uri' });
});

test('it answers a registration with 503 once 100 clients are waiting for a grant', async () => {
  await using server = await setupMCPHTTP();

  const waiting = await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const response = await fetch(`${server.url}/register`, {
        method: 'POST',
        body: JSON.stringify({
          client_name: `client ${index}`,
          redirect_uris: ['https://dots.example/cb'],
        }),
      });

      await response.text();

      return response.status;
    }),
  );

  const refused = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({
      client_name: 'one too many',
      redirect_uris: ['https://dots.example/cb'],
    }),
  });

  const refusal = await readJSONRecord(refused);

  expect(waiting).toSatisfyAll((status: number) => status === 201);
  expect(refused.status).toBe(503);
  expect(refusal).toMatchObject({ error: 'temporarily_unavailable' });
});

test('it registers a client name with its terminal escapes dropped', async () => {
  await using server = await setupMCPHTTP();

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({
      client_name: `dots\u001B]52;c;AAAA\u0007\nApprove evil${String.fromCodePoint(0x20_2e)}`,
      redirect_uris: ['https://dots.example/cb'],
    }),
  });

  const registration = await readJSONRecord(registered);

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(registration['client_id']),
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const consent = await fetch(authorize);

  await consent.text();

  expect(registration['client_name']).toBe('dots]52;c;AAAA Approve evil');
  expect(server.approvals).toBeArrayOfSize(1);

  expect(server.approvals[0]).toMatch(
    /^Approve dots\]52;c;AAAA Approve evil \(unverified, registered itself; returns to dots\.example\)/,
  );
});
