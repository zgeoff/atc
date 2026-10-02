import { expect, test } from 'bun:test';
import { readJSONRecord } from './read-json-record';
import { runMCPAuthorization } from './run-mcp-authorization';
import { setupMCPHTTP } from './setup-mcp-http';

test('it returns an authorization code for a freshly registered client', async () => {
  await using server = await setupMCPHTTP();

  const { clientID, code, ...rest } = await runMCPAuthorization(server, ['read']);

  expect(clientID).toMatch(/^c-/);
  expect(code).toMatch(/^atc_ac_/);

  expect(rest).toStrictEqual({
    redirectURI: 'https://dots.example/cb',
    verifier: 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz',
  });
});

test('it asks for only the requested scope when one is given', async () => {
  await using server = await setupMCPHTTP();

  const authorized = await runMCPAuthorization(server, ['read', 'kill'], 'kill');

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

  expect(tokens['scope']).toBe('kill');
});
