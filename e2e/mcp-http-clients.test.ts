import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config';
import { resolveATCCommand, runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { runClients } from '../packages/app/src/clients';

// Each test runs one atc clients command as a process, and a test that needs
// a client first adds it in the test's process to the database that command
// reads.
function setupTest() {
  const home = setupTempDir('atc-e2e-clients-');

  return {
    atc: resolveATCCommand(),
    env: { PATH: process.env['PATH'] ?? '', HOME: home.path },
    dbPath: resolvePaths({ HOME: home.path }).mcpAuthDBFile,
  };
}

test('it adds a client through atc clients and prints its client ID', async () => {
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
});

test('it lists a client with every redirect URI it was given through atc clients', async () => {
  const ctx = setupTest();
  const printed: string[] = [];

  await runClients(
    {
      kind: 'add',
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      exit: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(printed.join('\n'))?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${printed.join('\n')}`);

  const listed = await runCommand([...ctx.atc, 'clients'], { env: ctx.env });

  expect(listed.stdout).toBe(
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback\n`,
  );
});

test('it removes a client through atc clients', async () => {
  const ctx = setupTest();
  const printed: string[] = [];

  await runClients(
    { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      exit: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(printed.join('\n'))?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${printed.join('\n')}`);

  const removed = await runCommand([...ctx.atc, 'clients', 'remove', clientID], { env: ctx.env });

  expect(removed.stdout).toBe(`Removed client ${clientID} and revoked every grant it held\n`);
});
