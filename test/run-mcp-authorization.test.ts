import { expect, test } from 'bun:test';
import { runMCPAuthorization } from './run-mcp-authorization';
import { setupMCPHTTP } from './setup-mcp-http';

test('it returns an authorization code at the redirect URI with a verifier for it', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['read'],
  });

  expect(authorized.callback.href).toStartWith('https://dots.example/cb?code=');
  expect(authorized.callback.searchParams.get('code')).toBe(authorized.code);
  expect(authorized.verifier).toStartWith('test-verifier-');
});

test('it throws when the authorization stops short of the login page', async () => {
  await using server = await setupMCPHTTP();

  const authorizing = runMCPAuthorization(server, {
    clientID: 'unknown-client',
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: ['read'],
  });

  expect(authorizing).rejects.toThrow('authorization did not reach the login page');
});
