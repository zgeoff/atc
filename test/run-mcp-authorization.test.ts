import { expect, test } from 'bun:test';
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
