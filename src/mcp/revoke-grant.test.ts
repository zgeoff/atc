import { expect, test } from 'bun:test';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../test-utils/setup-mcp-http';
import { collectGrants } from './collect-grants';
import { revokeGrant } from './revoke-grant';

test("it forgets the consent its client held along with the grant's tokens", async () => {
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

  const revoked = await revokeGrant(server.store.db, grant.grantID);
  const consents = await server.store.db.selectFrom('oauthConsent').select('id').execute();
  const grants = await collectGrants(server.store.db);

  expect(revoked).toBeTrue();
  expect(consents).toStrictEqual([]);
  expect(grants).toStrictEqual([]);
});

test('it reports an unknown grant id as not revoked', async () => {
  await using server = await setupMCPHTTP();

  const revoked = await revokeGrant(server.store.db, 'unknown-grant');

  expect(revoked).toBeFalse();
});
