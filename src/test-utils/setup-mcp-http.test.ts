import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupMCPHTTP } from './setup-mcp-http';

test('it collects the approval line the server prints', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: 'https://dots.example/cb',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  expect(server.approvals).toBeArrayOfSize(1);
  expect(server.approvals[0]).toStartWith('Approve dots (returns to dots.example) with code ');
});

test('it keeps the authorization database where atc keeps it under the home directory', async () => {
  await using server = await setupMCPHTTP();

  expect(server.dbPath).toBe(join(server.home, '.local', 'state', 'atc', 'mcp-auth.db'));
  expect(existsSync(server.dbPath)).toBeTrue();
});

test('it counts the daemon connections the caller holds open', async () => {
  await using server = await setupMCPHTTP();

  const before = server.countDaemonClients();

  await server.caller.sendRequest('session.list');

  expect(before).toBe(0);
  expect(server.countDaemonClients()).toBe(1);
});
