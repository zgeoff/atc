import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readJSONRecord } from './test-utils/read-json-record';
import { runMCPAuthorization } from './test-utils/run-mcp-authorization';
import { setupMCPHTTP } from './test-utils/setup-mcp-http';

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
    cli: join(import.meta.dir, 'cli.ts'),
    env: { PATH: process.env['PATH'] ?? '', HOME: server.home },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

// A grant id is random base64url, so one in 64 starts with a dash; this one
// does, with an underscore after it, the shape an argument parser reads as a
// group of short flags.
test('it lists a grant whose id starts with a dash', async () => {
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

  await fetch(`${ctx.server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      client_id: clientID,
      code_verifier: authorized.verifier,
    }),
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

  const listed = Bun.spawnSync([process.execPath, ctx.cli, 'grants'], { env: ctx.env });

  expect(listed.stdout.toString()).toBe(
    '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc  Claude  read  last used never\n',
  );
});

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

    const revoked = Bun.spawnSync([process.execPath, ctx.cli, 'grants', ...row.args], {
      env: ctx.env,
    });

    const pinged = await fetch(`${ctx.server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    const listed = Bun.spawnSync([process.execPath, ctx.cli, 'grants'], { env: ctx.env });

    expect({
      stdout: revoked.stdout.toString(),
      stderr: revoked.stderr.toString(),
      pinged: pinged.status,
      listed: listed.stdout.toString(),
    }).toStrictEqual({
      stdout: `Revoked grant ${row.grantID}\n`,
      stderr: '',
      pinged: 401,
      listed: 'No grants.\n',
    });
  },
);

test('it refuses to revoke an unknown grant', async () => {
  await using ctx = await setupTest();

  const revoked = Bun.spawnSync([process.execPath, ctx.cli, 'grants', '--revoke', 'unknown'], {
    env: ctx.env,
  });

  expect({ exitCode: revoked.exitCode, stderr: revoked.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: "atc grants: no grant has the ID 'unknown'\n",
  });
});
