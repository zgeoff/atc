import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readJSONRecord } from '../test/read-json-record';
import { runMCPAuthorization } from '../test/run-mcp-authorization';
import { setupMCPHTTP } from '../test/setup-mcp-http';

test('it lists a grant and revokes it so its access token stops working', async () => {
  await using server = await setupMCPHTTP();

  const clientID = await server.addClient('Claude', ['https://claude.ai/api/mcp/auth_callback']);

  const authorized = await runMCPAuthorization(server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const env = { PATH: process.env['PATH'] ?? '', HOME: server.home };
  const cli = join(import.meta.dir, 'cli.ts');
  const listed = Bun.spawnSync([process.execPath, cli, 'grants'], { env });

  const grantID = /^(?<id>\S+) {2}Claude {2}read {2}last used never\n$/.exec(
    listed.stdout.toString(),
  )?.groups?.['id'];

  if (grantID === undefined) {
    throw new Error(`no grant in: ${listed.stdout.toString()}`);
  }

  const revoked = Bun.spawnSync([process.execPath, cli, 'grants', '--revoke', grantID], { env });

  const pinged = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const emptied = Bun.spawnSync([process.execPath, cli, 'grants'], { env });

  expect(revoked.stdout.toString()).toBe(`Revoked grant ${grantID}\n`);
  expect(pinged.status).toBe(401);
  expect(emptied.stdout.toString()).toBe('No grants.\n');
});

test('it refuses to revoke an unknown grant', async () => {
  await using server = await setupMCPHTTP();

  const revoked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'grants', '--revoke', 'unknown'],
    { env: { PATH: process.env['PATH'] ?? '', HOME: server.home } },
  );

  expect(revoked.exitCode).toBe(1);
  expect(revoked.stderr.toString()).toBe("atc grants: no grant has the ID 'unknown'\n");
});
