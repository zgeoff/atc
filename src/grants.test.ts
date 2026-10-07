import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readJSONRecord } from './test-utils/read-json-record';
import { runMCPAuthorization } from './test-utils/run-mcp-authorization';
import { setupMCPHTTP } from './test-utils/setup-mcp-http';

// A grant id is random base64url, so one in 64 starts with a dash; this one
// does, with an underscore after it, the shape an argument parser reads as a
// group of short flags.
const DASH_GRANT_ID = '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc';

test.each([
  ['--revoke <id>', ['--revoke', DASH_GRANT_ID]],
  ['--revoke=<id>', [`--revoke=${DASH_GRANT_ID}`]],
])(
  'it lists a grant whose id starts with a dash and revokes it with %s so its access token stops working',
  async (_form, revokeArgs) => {
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

    const grantID = DASH_GRANT_ID;

    await server.store.db
      .updateTable('oauthAccessToken')
      .set({ authorizationCodeId: grantID })
      .where('clientId', '=', clientID)
      .execute();

    await server.store.db
      .updateTable('oauthRefreshToken')
      .set({ authorizationCodeId: grantID })
      .where('clientId', '=', clientID)
      .execute();

    const env = { PATH: process.env['PATH'] ?? '', HOME: server.home };
    const cli = join(import.meta.dir, 'cli.ts');
    const listed = Bun.spawnSync([process.execPath, cli, 'grants'], { env });
    const revoked = Bun.spawnSync([process.execPath, cli, 'grants', ...revokeArgs], { env });

    const pinged = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    const emptied = Bun.spawnSync([process.execPath, cli, 'grants'], { env });

    expect(listed.stdout.toString()).toBe(`${grantID}  Claude  read  last used never\n`);
    expect(revoked.stderr.toString()).toBe('');
    expect(revoked.stdout.toString()).toBe(`Revoked grant ${grantID}\n`);
    expect(pinged.status).toBe(401);
    expect(emptied.stdout.toString()).toBe('No grants.\n');
  },
);

test('it refuses to revoke an unknown grant', async () => {
  await using server = await setupMCPHTTP();

  const revoked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'grants', '--revoke', 'unknown'],
    { env: { PATH: process.env['PATH'] ?? '', HOME: server.home } },
  );

  expect(revoked.exitCode).toBe(1);
  expect(revoked.stderr.toString()).toBe("atc grants: no grant has the ID 'unknown'\n");
});
