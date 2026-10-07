import { expect, test } from 'bun:test';
import { readJSONRecord } from '../src/test-utils/read-json-record';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runMCPAuthorization } from '../src/test-utils/run-mcp-authorization';
import { setupMCPHTTP } from '../src/test-utils/setup-mcp-http';

/**
 * A real daemon behind `atc mcp --http`, whose authorization database sits
 * under a temp home, and the environment that points a spawned CLI at that
 * home, so `atc grants` reads the grants the server issued. Disposal stops
 * both and removes the home.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const server = await setupMCPHTTP();

  stack.use(server);

  const owned = stack.move();

  return {
    server,
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: server.home },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

// Each row's grant id starts with a dash, with an underscore after it, the
// shape an argument parser reads as a group of short flags.
test.each([
  {
    form: '--revoke <id>',
    grantID: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc',
    args: ['--revoke', '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
  },
  {
    form: '--revoke=<id>',
    grantID: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc',
    args: ['--revoke=-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
  },
])(
  'it revokes a grant whose id starts with a dash with $form so its access token stops working',
  async (row) => {
    await using ctx = await setupTest();

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

    await ctx.server.store.db
      .updateTable('oauthAccessToken')
      .set({ authorizationCodeId: row.grantID })
      .where('clientId', '=', clientID)
      .execute();

    await ctx.server.store.db
      .updateTable('oauthRefreshToken')
      .set({ authorizationCodeId: row.grantID })
      .where('clientId', '=', clientID)
      .execute();

    const revoked = Bun.spawnSync([...ctx.atc, 'grants', ...row.args], { env: ctx.env });

    const pinged = await fetch(`${ctx.server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    const listed = Bun.spawnSync([...ctx.atc, 'grants'], { env: ctx.env });
    const again = Bun.spawnSync([...ctx.atc, 'grants', ...row.args], { env: ctx.env });

    expect({
      exitCode: revoked.exitCode,
      stdout: revoked.stdout.toString(),
      stderr: revoked.stderr.toString(),
      pinged: pinged.status,
      listed: listed.stdout.toString(),
      again: { exitCode: again.exitCode, stderr: again.stderr.toString() },
    }).toStrictEqual({
      exitCode: 0,
      stdout: `Revoked grant ${row.grantID}\n`,
      stderr: '',
      pinged: 401,
      listed: 'No grants.\n',
      again: { exitCode: 1, stderr: `atc grants: no grant has the ID '${row.grantID}'\n` },
    });
  },
);
