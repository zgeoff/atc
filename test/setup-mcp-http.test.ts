import { expect, test } from 'bun:test';
import { deriveTokenHash } from '../src/mcp/derive-token-hash';
import { readJSONRecord } from './read-json-record';
import { setupMCPHTTP } from './setup-mcp-http';

test('it serves the authorization server metadata at its local origin', async () => {
  await using server = await setupMCPHTTP();

  const response = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
  const metadata: unknown = await response.json();

  expect(server.origin).toBe(server.url);

  expect(metadata).toStrictEqual({
    issuer: server.origin,
    authorization_endpoint: `${server.origin}/authorize`,
    token_endpoint: `${server.origin}/token`,
    registration_endpoint: `${server.origin}/register`,
    scopes_supported: ['read', 'message', 'spawn', 'kill'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
});

test('it collects the approval line the server prints', async () => {
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

  await consent.text();

  expect(server.approvals).toBeArrayOfSize(1);

  expect(server.approvals[0]).toMatch(
    /^Approve dots \(.+\) with code \w{4}-\w{4}\. The code expires in 10 minutes\.$/,
  );
});

test('it keeps serving the grants the daemon held across a restart', async () => {
  await using server = await setupMCPHTTP();

  await server.caller.sendRequest('grant.create', {
    clientID: 'c1',
    clientName: 'dots',
    scopes: ['read'],
    resource: `${server.origin}/mcp`,
    accessHash: deriveTokenHash('atc_at_restart'),
    refreshHash: deriveTokenHash('atc_rt_restart'),
  });

  await server.restartDaemon();

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer atc_at_restart' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const body: unknown = await pinged.json();

  expect(pinged.status).toBe(200);
  expect(body).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('it counts the daemon connections the caller holds open', async () => {
  await using server = await setupMCPHTTP();

  const before = server.countDaemonClients();

  await server.caller.sendRequest('grant.list');

  expect(before).toBe(0);
  expect(server.countDaemonClients()).toBe(1);
});
