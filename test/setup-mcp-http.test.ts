import { expect, test } from 'bun:test';
import { setupMCPHTTP } from './setup-mcp-http';

test('it serves the authorization server metadata at its local origin', async () => {
  await using server = await setupMCPHTTP();

  const response = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
  const metadata: unknown = await response.json();

  expect(metadata).toMatchObject({ issuer: server.origin });
});
