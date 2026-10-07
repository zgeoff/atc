import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A fresh home for the CLI, where its authorization database lands, and the
 * environment that points a spawned CLI at it. Disposal removes the home.
 */
function setupTest() {
  const home = setupTempDir('atc-clients-');

  return {
    cli: join(import.meta.dir, 'cli.ts'),
    env: { PATH: process.env['PATH'] ?? '', HOME: home.dir },
    [Symbol.dispose]: home[Symbol.dispose],
  };
}

test('it adds a client and prints its client ID', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      process.execPath,
      ctx.cli,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { env: ctx.env },
  );

  expect(added.exitCode).toBe(0);
  expect(added.stdout.toString()).toMatch(/^Added Claude\. Its client ID is \w+\n$/u);
});

test('it lists an added client with every redirect URI it was given', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      process.execPath,
      ctx.cli,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--redirect-uri=https://claude.com/api/mcp/auth_callback',
    ],
    { env: ctx.env },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout.toString()}`);
  }

  const listed = Bun.spawnSync([process.execPath, ctx.cli, 'clients'], { env: ctx.env });

  expect(listed.stdout.toString()).toBe(
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback\n`,
  );
});

test('it removes a client and says it revoked every grant the client held', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      process.execPath,
      ctx.cli,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { env: ctx.env },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout.toString()}`);
  }

  const removed = Bun.spawnSync([process.execPath, ctx.cli, 'clients', 'remove', clientID], {
    env: ctx.env,
  });

  expect(removed.stdout.toString()).toBe(
    `Removed client ${clientID} and revoked every grant it held\n`,
  );
});

test('it lists no clients and how to add one once the last client is removed', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      process.execPath,
      ctx.cli,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { env: ctx.env },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout.toString()}`);
  }

  Bun.spawnSync([process.execPath, ctx.cli, 'clients', 'remove', clientID], { env: ctx.env });

  const listed = Bun.spawnSync([process.execPath, ctx.cli, 'clients'], { env: ctx.env });

  expect(listed.stdout.toString()).toBe(
    'No clients. Add one with: atc clients add <name> --redirect-uri <uri>\n',
  );
});

test('it refuses a redirect URI that is not https or loopback http', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      process.execPath,
      ctx.cli,
      'clients',
      'add',
      'dots',
      '--redirect-uri',
      'http://dots.example/cb',
    ],
    { env: ctx.env },
  );

  expect({ exitCode: added.exitCode, stderr: added.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr:
      "atc clients add: 'http://dots.example/cb' is not a redirect URI atc accepts; use https, or http on a loopback host, with no fragment\n",
  });
});

test('it refuses to remove an unknown client', () => {
  using ctx = setupTest();

  const removed = Bun.spawnSync([process.execPath, ctx.cli, 'clients', 'remove', 'unknown'], {
    env: ctx.env,
  });

  expect({ exitCode: removed.exitCode, stderr: removed.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: "atc clients remove: no client has the ID 'unknown'\n",
  });
});
