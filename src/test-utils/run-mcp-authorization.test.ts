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

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorizing = runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read write',
    ticked: ['read'],
  });

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    /^authorization did not reach the login page: https:\/\/dots\.example\/cb\?error=invalid_scope&/,
  );
});

test('it throws when the server printed no approval code', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorizing = runMCPAuthorization(
    { url: server.url, origin: server.origin, approvals: [] },
    { clientID, redirectURI: 'https://dots.example/cb', scope: 'read', ticked: ['read'] },
  );

  expect(authorizing).rejects.toThrowWithMessage(Error, 'the server printed no approval code');
});

test('it throws when the approval code does not reach the consent page', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorizing = runMCPAuthorization(
    {
      url: server.url,
      origin: server.origin,
      approvals: ['Approve dots (returns to dots.example) with code 0000-0000'],
    },
    { clientID, redirectURI: 'https://dots.example/cb', scope: 'read', ticked: ['read'] },
  );

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    `the approval code did not reach the consent page: ${server.url}/`,
  );
});

test('it throws when the consent redirect holds no authorization code', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('dots', ['https://dots.example/cb']);

  const authorizing = runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://dots.example/cb',
    scope: 'read',
    ticked: [],
  });

  expect(authorizing).rejects.toThrowWithMessage(
    Error,
    /^the consent redirect holds no authorization code: https:\/\/dots\.example\/cb\?error=access_denied&/,
  );
});
