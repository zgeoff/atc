import { expect, test } from 'bun:test';
import { resolveATCCommand, runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const home = setupTempDir('atc-e2e-clients-');

  return {
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: home.path },
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
