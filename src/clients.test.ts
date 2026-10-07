import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runClients } from './clients';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory that holds the authorization database the command opens.
 * Disposal removes the directory.
 */
function setupTest() {
  const tmp = setupTempDir('atc-clients-');

  return {
    dbPath: join(tmp.dir, 'state', 'mcp-auth.db'),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it adds a client and prints its client ID', async () => {
  using ctx = setupTest();

  const printed: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];

  await runClients(
    { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
    },
  );

  expect({ errors, codes }).toStrictEqual({ errors: [], codes: [] });
  expect(printed.join('\n')).toMatch(/^Added Claude\. Its client ID is \w+$/u);
});

test('it lists an added client with every redirect URI it was given', async () => {
  using ctx = setupTest();

  const added: string[] = [];

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
        added.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.join('\n')}`);
  }

  const printed: string[] = [];

  await runClients(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toStrictEqual([
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback`,
  ]);
});

test('it removes a client and says it revoked every grant the client held', async () => {
  using ctx = setupTest();

  const added: string[] = [];

  await runClients(
    { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        added.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.join('\n')}`);
  }

  const printed: string[] = [];

  await runClients(
    { kind: 'remove', clientID },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toStrictEqual([`Removed client ${clientID} and revoked every grant it held`]);
});

test('it lists no clients and how to add one once the last client is removed', async () => {
  using ctx = setupTest();

  const added: string[] = [];

  await runClients(
    { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        added.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  if (clientID === undefined) {
    throw new Error(`no client ID in: ${added.join('\n')}`);
  }

  await runClients(
    { kind: 'remove', clientID },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    { print: () => {}, printError: () => {}, setExitCode: () => {} },
  );

  const printed: string[] = [];

  await runClients(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toStrictEqual([
    'No clients. Add one with: atc clients add <name> --redirect-uri <uri>',
  ]);
});

test('it refuses a redirect URI that is not https or loopback http', async () => {
  using ctx = setupTest();

  const errors: string[] = [];
  const codes: number[] = [];

  await runClients(
    { kind: 'add', name: 'dots', redirectURIs: ['http://dots.example/cb'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
    },
  );

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: [
      "atc clients add: 'http://dots.example/cb' is not a redirect URI atc accepts; use https, or http on a loopback host, with no fragment",
    ],
  });
});

test('it refuses to remove an unknown client', async () => {
  using ctx = setupTest();

  const errors: string[] = [];
  const codes: number[] = [];

  await runClients(
    { kind: 'remove', clientID: 'unknown' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
    },
  );

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: ["atc clients remove: no client has the ID 'unknown'"],
  });
});
