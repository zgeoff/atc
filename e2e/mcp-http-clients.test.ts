import { expect, test } from 'bun:test';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A fresh home for the CLI, where its authorization database lands, and the
 * environment that points a spawned CLI at it. Disposal removes the home.
 */
function setupTest() {
  const home = setupTempDir('atc-e2e-clients-');

  return {
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: home.dir },
    [Symbol.dispose]: home[Symbol.dispose],
  };
}

test('it adds, lists, and removes a client through atc clients', () => {
  using ctx = setupTest();

  const added = Bun.spawnSync(
    [
      ...ctx.atc,
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--redirect-uri=https://claude.com/api/mcp/auth_callback',
    ],
    { env: ctx.env },
  );

  expect(added.exitCode).toBe(0);
  expect(added.stdout.toString()).toMatch(/^Added Claude\. Its client ID is \w+\n$/u);

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout.toString())?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.stdout.toString()}`);
  }

  const listed = Bun.spawnSync([...ctx.atc, 'clients'], { env: ctx.env });

  expect(listed.stdout.toString()).toBe(
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback\n`,
  );

  const removed = Bun.spawnSync([...ctx.atc, 'clients', 'remove', clientID], { env: ctx.env });

  expect(removed.stdout.toString()).toBe(
    `Removed client ${clientID} and revoked every grant it held\n`,
  );

  const emptied = Bun.spawnSync([...ctx.atc, 'clients'], { env: ctx.env });

  expect(emptied.stdout.toString()).toBe(
    'No clients. Add one with: atc clients add <name> --redirect-uri <uri>\n',
  );

  const refused = Bun.spawnSync([...ctx.atc, 'clients', 'remove', clientID], { env: ctx.env });

  expect({ exitCode: refused.exitCode, stderr: refused.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `atc clients remove: no client has the ID '${clientID}'\n`,
  });
});
