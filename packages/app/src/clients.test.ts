import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { seedOwnerClient, seedOwnerSchema } from '@atc/mcp/test-utils';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { runClients } from './clients';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-clients-');
  const dbPath = join(temporaryDirectory.path, 'state', 'mcp-auth.db');

  return {
    dbPath,

    // atc's own server let two clients share a name, and the move to the
    // package keeps both.
    writeOldClients: (names: readonly string[]) => {
      const sqlite = openMCPAuthDatabase(dbPath);

      registerTestCleanup(() => {
        sqlite.close();
      });

      seedOwnerSchema(sqlite);

      return names.map((name) => seedOwnerClient(sqlite, { name }).clientID);
    },
  };
}

test('it adds a client and prints its client ID', async () => {
  const ctx = setupTest();
  const printed: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  const exits: number[] = [];

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
      exit: (code) => {
        exits.push(code);
      },
    },
  );

  expect({ errors, codes, exits }).toStrictEqual({ errors: [], codes: [], exits: [] });
  expect(printed.join('\n')).toMatch(/^Added Claude\. Its client ID is \w+$/u);
});

test('it lists an added client with every redirect URI it was given', async () => {
  const ctx = setupTest();
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
      exit: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${added.join('\n')}`);

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
      exit: () => {},
    },
  );

  expect(printed).toStrictEqual([
    `${clientID}  Claude  https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback`,
  ]);
});

test('it removes a client and says it revoked every grant the client held', async () => {
  const ctx = setupTest();
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
      exit: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${added.join('\n')}`);

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
      exit: () => {},
    },
  );

  expect(printed).toStrictEqual([`Removed client ${clientID} and revoked every grant it held`]);
});

test('it lists no clients and how to add one once the last client is removed', async () => {
  const ctx = setupTest();
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
      exit: () => {},
    },
  );

  const clientID = /client ID is (?<id>\w+)/u.exec(added.join('\n'))?.groups?.['id'];

  invariant(clientID !== undefined, `no client ID in: ${added.join('\n')}`);

  await runClients(
    { kind: 'remove', clientID },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    { print: () => {}, printError: () => {}, setExitCode: () => {}, exit: () => {} },
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
      exit: () => {},
    },
  );

  expect(printed).toStrictEqual([
    'No clients. Add one with: atc clients add <name> --redirect-uri <uri>',
  ]);
});

test('it exits 1 when an add gives no redirect URI', async () => {
  const ctx = setupTest();
  const errors: string[] = [];
  const codes: number[] = [];
  const exits: number[] = [];

  await runClients(
    { kind: 'add', name: 'Claude', redirectURIs: [] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
      exit: (code) => {
        exits.push(code);
      },
    },
  );

  expect({ exits, codes, errors }).toStrictEqual({
    exits: [1],
    codes: [],
    errors: ['atc clients add: give at least one --redirect-uri'],
  });
});

test('it exits 1 for a redirect URI that is not https or loopback http', async () => {
  const ctx = setupTest();
  const errors: string[] = [];
  const codes: number[] = [];
  const exits: number[] = [];

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
      exit: (code) => {
        exits.push(code);
      },
    },
  );

  expect({ exits, codes, errors }).toStrictEqual({
    exits: [],
    codes: [1],
    errors: [
      'atc clients add: a redirect URI is not one atc accepts; use https, or http on a loopback host, with no fragment',
    ],
  });
});

test('it exits 1 when a client already has the name', async () => {
  const ctx = setupTest();
  const errors: string[] = [];
  const codes: number[] = [];

  await runClients(
    { kind: 'add', name: 'dots', redirectURIs: ['https://dots.example/cb'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    { print: () => {}, printError: () => {}, setExitCode: () => {}, exit: () => {} },
  );

  await runClients(
    { kind: 'add', name: 'dots', redirectURIs: ['https://dots.example/other'] },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
      exit: () => {},
    },
  );

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: ['atc clients add: a client already has that name'],
  });
});

test('it refuses to remove an unknown client', async () => {
  const ctx = setupTest();
  const errors: string[] = [];
  const codes: number[] = [];
  const exits: number[] = [];

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
      exit: (code) => {
        exits.push(code);
      },
    },
  );

  expect({ exits, codes, errors }).toStrictEqual({
    exits: [],
    codes: [1],
    errors: ["atc clients remove: no client has the ID 'unknown'"],
  });
});

test('it sets the process exit code to 1 when it refuses a remove by default', async () => {
  const ctx = setupTest();

  // Bun ignores an assignment of undefined, so an unset exit code goes back
  // as 0, the code an unset one exits with.
  const exitCode = process.exitCode ?? 0;

  onTestFinished(() => {
    process.exitCode = exitCode;
  });

  await runClients(
    { kind: 'remove', clientID: 'unknown' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
  );

  expect(process.exitCode).toBe(1);
});

test('it refuses to remove a client whose name another client shares, and removes neither', async () => {
  const ctx = setupTest();
  const [, second] = ctx.writeOldClients(['Orchard', 'Orchard']);
  const errors: string[] = [];
  const codes: number[] = [];
  const listed: string[] = [];

  await runClients(
    { kind: 'remove', clientID: second ?? '' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
      exit: () => {},
    },
  );

  await runClients(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc clients' },
    {
      print: (line) => {
        listed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      exit: () => {},
    },
  );

  expect({ errors, codes, listed: listed.length }).toStrictEqual({
    errors: [
      "atc clients remove: another client has the name 'Orchard', so atc cannot remove this one alone",
    ],
    codes: [1],
    listed: 2,
  });
});
