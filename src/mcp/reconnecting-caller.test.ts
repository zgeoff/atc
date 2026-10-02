import { expect, test } from 'bun:test';
import { setupMCPHTTP } from '../../test/setup-mcp-http';

test('it answers a read-only request sent right after the daemon restarts', async () => {
  await using mcp = await setupMCPHTTP();

  const before = await mcp.caller.sendRequest('grant.list');

  await mcp.restartDaemon();

  const after = mcp.caller.sendRequest('grant.verify', {
    accessHash: 'unknown',
    resource: `${mcp.origin}/mcp`,
  });

  expect(before).toStrictEqual({ grants: [] });
  expect(after).rejects.toMatchObject({ code: 'unauthorized' });
});
