import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { systemClock } from '@atc/core';
import { openATCAuth } from '@atc/mcp';
import { seedOwnerClient, seedOwnerGrant, seedOwnerSchema } from '@atc/mcp/test-utils';
import { registerTestCleanup, resolveATCCommand, runCommand, setupTempDir } from '@atc/test-utils';
import { openMCPAuthDatabase } from '../packages/app/src/open-mcp-auth-database';

// An authorization database from before atc moved to its shared OAuth
// server, under a home of its own, holding one grant with the given ID.
function setupTest(grantID: string) {
  const home = setupTempDir('atc-e2e-grants-').path;
  const dbPath = resolvePaths({ HOME: home }).mcpAuthDBFile;

  mkdirSync(join(dbPath, '..'), { recursive: true });

  const sqlite = openMCPAuthDatabase(dbPath);

  registerTestCleanup(() => {
    sqlite.close();
  });

  const owner = seedOwnerSchema(sqlite);
  const client = seedOwnerClient(sqlite, { name: 'Claude' });

  const grant = seedOwnerGrant(sqlite, {
    ownerID: owner.ownerID,
    clientID: client.clientID,
    resource: 'https://atc.example/mcp',
    scopes: ['read'],
    grantID,
  });

  return {
    sqlite,
    grant,
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
  };
}

// A grant made before the move keeps its authorization code as its ID, which
// can start with a dash and an underscore, the shape an argument parser reads
// as a group of short flags.
test('it revokes a grant whose id starts with a dash with --revoke=<id> so its access token stops working', async () => {
  const ctx = setupTest('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc');

  const revoked = await runCommand(
    [...ctx.atc, 'grants', '--revoke=-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc'],
    { env: ctx.env },
  );

  const auth = await openATCAuth({
    database: ctx.sqlite,
    origin: 'https://atc.example',
    clock: systemClock,
    security: { record: () => {} },
    serviceTokens: null,
    onGrantRevoked: () => {},
  });

  registerTestCleanup(() => auth.close());

  expect({
    exitCode: revoked.exitCode,
    stdout: revoked.stdout,
    stderr: revoked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'Revoked grant -yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc\n',
    stderr: '',
  });

  expect(auth.verify(ctx.grant.accessToken)).resolves.toBeNull();
});
