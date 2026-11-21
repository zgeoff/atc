import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { openATCAuth } from '@atc/mcp';
import { seedOwnerClient } from '@atc/mcp/test-utils/seed-owner-client';
import { seedOwnerGrant } from '@atc/mcp/test-utils/seed-owner-grant';
import { seedOwnerSchema } from '@atc/mcp/test-utils/seed-owner-schema';
import { systemClock } from '@zgeoff/std';
import { registerTestCleanup } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { openMCPAuthDatabase } from '../packages/app/src/mcp/open-mcp-auth-database';

function setupTest(grantID: string) {
  const home = createTempDir('atc-e2e-grants-').path;
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

// A grant ID can start with a dash, the shape an argument parser reads as a group of short flags.
test('it revokes a grant whose id starts with a dash with --revoke=<id> so its access token stops working', async () => {
  const ctx = setupTest('-yZRPpyZlelRN38oFXCrOzyQv3VRUBE1m3h_yIrJvhc');

  const revoked = await run(
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
