import { expect, test } from 'bun:test';
import { runMCPAuthorization } from '../test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../test-utils/setup-mcp-http';
import { collectGrants } from './collect-grants';
import { revokeGrant } from './revoke-grant';

function setupTest() {
  return setupMCPHTTP();
}

test("it forgets the consent its client held along with the grant's tokens", async () => {
  await using ctx = await setupTest();

  const clientID = await ctx.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(ctx, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    ticked: ['read'],
  });

  await fetch(`${ctx.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const [grant] = await collectGrants(ctx.store.db);

  if (grant === undefined) {
    throw new Error('the exchange left no grant');
  }

  const revoked = await revokeGrant(ctx.store.db, grant.grantID);
  const consents = await ctx.store.db.selectFrom('oauthConsent').select('id').execute();
  const grants = await collectGrants(ctx.store.db);

  expect(revoked).toBeTrue();
  expect(consents).toStrictEqual([]);
  expect(grants).toStrictEqual([]);
});

test('it reports an unknown grant id as not revoked', async () => {
  await using ctx = await setupTest();

  const revoked = await revokeGrant(ctx.store.db, 'unknown-grant');

  expect(revoked).toBeFalse();
});
