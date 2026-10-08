import { expect, test } from 'bun:test';
import { readJSONRecord } from '../src/test-utils/read-json-record';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runMCPAuthorization } from '../src/test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../src/test-utils/setup-mcp-http';

/**
 * A real daemon behind `atc mcp --http`, whose authorization database sits
 * under a temp home, and the environment that points a spawned CLI at that
 * home, so `atc grants` reads the grants the server issued. Both stop and
 * the home is removed once the test finishes.
 */
async function setupTest() {
  const server = await setupMCPHTTP();

  return {
    server,
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: server.home },
  };
}

// The grant id starts with a dash, with an underscore after it, the shape an
// argument parser reads as a group of short flags.
test('it revokes a grant whose id starts with a dash with --revoke <id> so its access token stops working', async () => {
  const ctx = await setupTest();

  const clientID = await ctx.server.addClient('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
  ]);

  const authorized = await runMCPAuthorization(ctx.server, {
    clientID,
    redirectURI: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read message',
    ticked: ['read'],
  });

  const exchanged = await fetch(`${ctx.server.url}/oauth2/token`, {
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

  const before = await fetch(`${ctx.server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  await ctx.server.store.db
    .updateTable('oauthAccessToken')
    .set({ authorizationCodeId: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc' })
    .where('clientId', '=', clientID)
    .execute();

  await ctx.server.store.db
    .updateTable('oauthRefreshToken')
    .set({ authorizationCodeId: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc' })
    .where('clientId', '=', clientID)
    .execute();

  const revoked = Bun.spawnSync(
    [...ctx.atc, 'grants', '--revoke', '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
    { env: ctx.env },
  );

  const pinged = await fetch(`${ctx.server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  expect(exchanged.status).toBe(200);
  expect(before.status).toBe(200);

  expect({
    exitCode: revoked.exitCode,
    stdout: revoked.stdout.toString(),
    stderr: revoked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'Revoked grant -yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc\n',
    stderr: '',
  });

  expect(pinged.status).toBe(401);
});
