import { expect, onTestFinished, test } from 'bun:test';
import { runGrants } from './grants';
import { readJSONRecord } from './test-utils/read-json-record';
import { runMCPAuthorization } from './test-utils/run-mcp-authorization';
import { setupMCPHTTP } from './test-utils/setup-mcp-http';

/**
 * A real daemon behind `atc mcp --http`, whose authorization database the
 * command opens, so it reads the grants the server issued. Disposal stops
 * both and removes the home.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const server = await setupMCPHTTP();

  stack.use(server);

  const owned = stack.move();

  return { server, [Symbol.asyncDispose]: () => owned.disposeAsync() };
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

  const printed: string[] = [];

  await runGrants(null, ctx.server.dbPath, {
    print: (line) => {
      printed.push(line);
    },
    printError: () => {},
    setExitCode: () => {},
  });

  expect(printed).toStrictEqual([
    '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc  Claude  read  last used never',
  ]);
});

test('it revokes a grant so its access token stops working and it lists no grants', async () => {
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
    .set({ authorizationCodeId: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc' })
    .where('clientId', '=', clientID)
    .execute();

  await ctx.server.store.db
    .updateTable('oauthRefreshToken')
    .set({ authorizationCodeId: '-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc' })
    .where('clientId', '=', clientID)
    .execute();

  const printed: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];

  await runGrants('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc', ctx.server.dbPath, {
    print: (line) => {
      printed.push(line);
    },
    printError: (line) => {
      errors.push(line);
    },
    setExitCode: (code) => {
      codes.push(code);
    },
  });

  const pinged = await fetch(`${ctx.server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${String(tokens['access_token'])}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  const listed: string[] = [];

  await runGrants(null, ctx.server.dbPath, {
    print: (line) => {
      listed.push(line);
    },
    printError: () => {},
    setExitCode: () => {},
  });

  expect({ printed, errors, codes, pinged: pinged.status, listed }).toStrictEqual({
    printed: ['Revoked grant -yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
    errors: [],
    codes: [],
    pinged: 401,
    listed: ['No grants.'],
  });
});

test('it refuses to revoke an unknown grant', async () => {
  await using ctx = await setupTest();

  const errors: string[] = [];
  const codes: number[] = [];

  await runGrants('unknown', ctx.server.dbPath, {
    print: () => {},
    printError: (line) => {
      errors.push(line);
    },
    setExitCode: (code) => {
      codes.push(code);
    },
  });

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: ["atc grants: no grant has the ID 'unknown'"],
  });
});

test('it sets the process exit code to 1 when it refuses to revoke by default', async () => {
  await using ctx = await setupTest();

  onTestFinished(() => {
    process.exitCode = 0;
  });

  await runGrants('unknown', ctx.server.dbPath);

  expect(process.exitCode).toBe(1);
});
