import { expect, test } from 'bun:test';
import { setupMCPHTTP } from '../../test/setup-mcp-http';
import { revokeGrant } from './revoke-grant';

test('it reports an unknown grant id as not revoked', async () => {
  await using server = await setupMCPHTTP();

  const revoked = await revokeGrant(server.store.db, 'unknown-grant');

  expect(revoked).toBeFalse();
});
