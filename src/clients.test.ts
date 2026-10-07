import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';

test('it adds, lists, and removes a client', () => {
  using home = setupTempDir('atc-clients-');

  const env = { PATH: process.env['PATH'] ?? '', HOME: home.dir };
  const cli = join(import.meta.dir, 'cli.ts');

  const added = Bun.spawnSync(
    [
      process.execPath,
      cli,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--redirect-uri=https://claude.com/api/mcp/auth_callback',
    ],
    { env },
  );

  const clientID = /client ID is (?<id>\w+)/.exec(added.stdout.toString())?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout.toString()}`);
  }

  const listed = Bun.spawnSync([process.execPath, cli, 'clients'], { env });
  const removed = Bun.spawnSync([process.execPath, cli, 'clients', 'remove', clientID], { env });
  const emptied = Bun.spawnSync([process.execPath, cli, 'clients'], { env });

  expect(added.stdout.toString()).toBe(`Added Claude. Its client ID is ${clientID}\n`);

  expect(listed.stdout.toString()).toBe(
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback\n`,
  );

  expect(removed.stdout.toString()).toBe(
    `Removed client ${clientID} and revoked every grant it held\n`,
  );

  expect(emptied.stdout.toString()).toBe(
    'No clients. Add one with: atc clients add <name> --redirect-uri <uri>\n',
  );
});

test('it refuses a redirect URI that is not https or loopback http', () => {
  using home = setupTempDir('atc-clients-');

  const added = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, 'cli.ts'),
      'clients',
      'add',
      'dots',
      '--redirect-uri',
      'http://dots.example/cb',
    ],
    { env: { PATH: process.env['PATH'] ?? '', HOME: home.dir } },
  );

  expect(added.exitCode).toBe(1);

  expect(added.stderr.toString()).toBe(
    "atc clients add: 'http://dots.example/cb' is not a redirect URI atc accepts; use https, or http on a loopback host, with no fragment\n",
  );
});

test('it refuses to remove an unknown client', () => {
  using home = setupTempDir('atc-clients-');

  const removed = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'clients', 'remove', 'unknown'],
    { env: { PATH: process.env['PATH'] ?? '', HOME: home.dir } },
  );

  expect(removed.exitCode).toBe(1);
  expect(removed.stderr.toString()).toBe("atc clients remove: no client has the ID 'unknown'\n");
});
