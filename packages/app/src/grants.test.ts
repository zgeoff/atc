import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { seedOwnerClient, seedOwnerGrant, seedOwnerSchema } from '@atc/mcp/test-utils';
import {
  readJSONRecord,
  registerTestCleanup,
  runMCPAuthorization,
  setupTempDir,
} from '@atc/test-utils';
import { runGrants } from './grants';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { setupMCPHTTP } from './test-utils/setup-mcp-http';

// A migrated grant needs no server, so the server starts only when a test
// asks for it.
function setupTest() {
  return {
    startServer: () => setupMCPHTTP(),

    // A grant made before atc moved to its shared OAuth server keeps the
    // authorization code it came from as its ID, which can start with a dash.
    writeMigratedGrant: (grantID: string) => {
      const temporaryDirectory = setupTempDir('atc-grants-');
      const dbPath = join(temporaryDirectory.path, 'state', 'mcp-auth.db');
      const sqlite = openMCPAuthDatabase(dbPath);

      registerTestCleanup(() => {
        sqlite.close();
      });

      const owner = seedOwnerSchema(sqlite);
      const client = seedOwnerClient(sqlite, { name: 'Claude' });

      seedOwnerGrant(sqlite, {
        ownerID: owner.ownerID,
        clientID: client.clientID,
        resource: 'https://atc.example/mcp',
        scopes: ['read'],
        grantID,
      });

      return { dbPath };
    },
  };
}

test('it lists a grant whose id starts with a dash', async () => {
  const ctx = setupTest().writeMigratedGrant('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc');
  const printed: string[] = [];

  await runGrants(null, ctx.dbPath, {
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

test('it revokes a grant whose id starts with a dash', async () => {
  const ctx = setupTest().writeMigratedGrant('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc');
  const printed: string[] = [];
  const listed: string[] = [];

  await runGrants('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc', ctx.dbPath, {
    print: (line) => {
      printed.push(line);
    },
    printError: () => {},
    setExitCode: () => {},
  });

  await runGrants(null, ctx.dbPath, {
    print: (line) => {
      listed.push(line);
    },
    printError: () => {},
    setExitCode: () => {},
  });

  expect({ printed, listed }).toStrictEqual({
    printed: ['Revoked grant -yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
    listed: ['No grants.'],
  });
});

test('it revokes a grant so its access token stops working and it lists no grants', async () => {
  const ctx = { server: await setupTest().startServer() };

  const clientID = await ctx.server.createClient('Claude', [
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
  const [grant] = await ctx.server.admin.grants.list();

  const printed: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];

  await runGrants(grant?.grantID ?? '', ctx.server.dbPath, {
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

  expect({ printed, errors, codes }).toStrictEqual({
    printed: [`Revoked grant ${grant?.grantID ?? ''}`],
    errors: [],
    codes: [],
  });

  expect(pinged.status).toBe(401);
  expect(listed).toStrictEqual(['No grants.']);
});

test('it refuses to revoke an unknown grant', async () => {
  const ctx = { server: await setupTest().startServer() };
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
  const ctx = { server: await setupTest().startServer() };

  // Bun ignores an assignment of undefined, so an unset exit code goes back
  // as 0, the code an unset one exits with.
  const exitCode = process.exitCode ?? 0;

  onTestFinished(() => {
    process.exitCode = exitCode;
  });

  await runGrants('unknown', ctx.server.dbPath);

  expect(process.exitCode).toBe(1);
});
