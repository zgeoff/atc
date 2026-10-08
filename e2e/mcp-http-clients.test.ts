import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runCommand } from '../src/test-utils/run-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A fresh home for the CLI, where its authorization database lands, and the
 * environment that points a spawned CLI at it. The home is removed once the
 * test finishes.
 */
function setupTest() {
  const home = setupTempDir('atc-e2e-clients-');

  return {
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: home.dir },
  };
}

test('it adds, lists, and removes a client through atc clients', async () => {
  const ctx = setupTest();

  const added = await runCommand(
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
  expect(added.stdout).toMatch(/^Added Claude\. Its client ID is \w+\n$/u);

  const clientID = /client ID is (?<id>\w+)/u.exec(added.stdout)?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${added.stdout}`);

  const listed = await runCommand([...ctx.atc, 'clients'], { env: ctx.env });

  expect(listed.stdout).toBe(
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback\n`,
  );

  const removed = await runCommand([...ctx.atc, 'clients', 'remove', clientID], { env: ctx.env });

  expect(removed.stdout).toBe(`Removed client ${clientID} and revoked every grant it held\n`);
});
