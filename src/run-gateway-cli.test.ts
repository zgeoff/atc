import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import pkg from '../package.json';
import { runGatewayCLI } from './run-gateway-cli';

test.each([
  { before: ['--state-dir', 'flagged', 'clients', 'add'], after: [] },
  { before: ['--state-dir=flagged', 'clients', 'add'], after: [] },
  { before: ['clients', '--state-dir', 'flagged', 'add'], after: [] },
  { before: ['clients', '--state-dir=flagged', 'add'], after: [] },
  { before: ['clients', 'add'], after: ['--state-dir', 'flagged'] },
  { before: ['clients', 'add'], after: ['--state-dir=flagged'] },
])(
  'it adds a client to the state directory in $before $after over the environment',
  async (row) => {
    const io = {
      runGateway: mock(),
      runClients: mock(),
      print: mock(),
      printError: mock(),
      exit: mock(),
    };

    await runGatewayCLI(
      [
        ...row.before,
        'Claude',
        '--redirect-uri',
        'https://claude.ai/api/mcp/auth_callback',
        ...row.after,
      ],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
      io,
    );

    expect(io.runClients).toHaveBeenCalledExactlyOnceWith(
      { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
      { dbPath: join('flagged', 'mcp-auth.db'), command: 'atc-gateway clients' },
    );
  },
);

test.each([
  { args: ['--state-dir', 'flagged', 'clients'] },
  { args: ['--state-dir=flagged', 'clients', 'list'] },
  { args: ['clients', '--state-dir', 'flagged'] },
  { args: ['clients', '--state-dir=flagged', 'list'] },
  { args: ['clients', 'list', '--state-dir', 'flagged'] },
  { args: ['clients', 'list', '--state-dir=flagged'] },
])('it lists the clients in the state directory in $args over the environment', async (row) => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(row.args, { ATC_GATEWAY_STATE_DIR: 'from-env' }, io);

  expect(io.runClients).toHaveBeenCalledExactlyOnceWith(
    { kind: 'list' },
    { dbPath: join('flagged', 'mcp-auth.db'), command: 'atc-gateway clients' },
  );
});

test.each([
  { before: ['--state-dir', 'flagged', 'clients', 'remove'], after: [] },
  { before: ['--state-dir=flagged', 'clients', 'remove'], after: [] },
  { before: ['clients', '--state-dir', 'flagged', 'remove'], after: [] },
  { before: ['clients', '--state-dir=flagged', 'remove'], after: [] },
  { before: ['clients', 'remove'], after: ['--state-dir', 'flagged'] },
  { before: ['clients', 'remove'], after: ['--state-dir=flagged'] },
])(
  'it removes a client from the state directory in $before $after over the environment',
  async (row) => {
    const io = {
      runGateway: mock(),
      runClients: mock(),
      print: mock(),
      printError: mock(),
      exit: mock(),
    };

    await runGatewayCLI(
      [...row.before, 'client-1', ...row.after],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
      io,
    );

    expect(io.runClients).toHaveBeenCalledExactlyOnceWith(
      { kind: 'remove', clientID: 'client-1' },
      { dbPath: join('flagged', 'mcp-auth.db'), command: 'atc-gateway clients' },
    );
  },
);

test.each([
  { args: ['--state-dir', 'flagged', 'serve'] },
  { args: ['--state-dir=flagged', 'serve'] },
  { args: ['serve', '--state-dir', 'flagged'] },
  { args: ['serve', '--state-dir=flagged'] },
])('it serves from the state directory in $args over the environment', async (row) => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    [...row.args, '--public-url', 'https://atc.geoff.cloud', '--registry', 'registry.json'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    io,
  );

  expect(io.runGateway).toHaveBeenCalledExactlyOnceWith(`atc-gateway/${pkg.version}`, {
    host: '127.0.0.1',
    port: 8414,
    publicURL: 'https://atc.geoff.cloud',
    registryPath: 'registry.json',
    stateDir: 'flagged',
  });
});

test('it exits 1 when it serves with no state directory', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    ['serve', '--public-url', 'https://atc.geoff.cloud', '--registry', 'registry.json'],
    {},
    io,
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR',
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runGateway).not.toHaveBeenCalled();
});

test('it exits 1 on two state directories that differ', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    [
      '--state-dir=first',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--state-dir',
      'second',
    ],
    {},
    io,
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    "atc-gateway: --state-dir gives different directories: 'first', 'second'",
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 when a flag takes the state directory flag as its value', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    ['clients', 'add', 'Claude', '--redirect-uri', '--state-dir', 'flagged'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    io,
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: --redirect-uri needs a value; write --redirect-uri=<value>',
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 on a flag it does not know at the root', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    [
      '--stat-dir=flagged',
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
    ],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    io,
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    "atc-gateway: unknown flag '--stat-dir=flagged'",
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 on a port it cannot parse', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(
    [
      'serve',
      '--port',
      'abc',
      '--public-url',
      'https://atc.geoff.cloud',
      '--registry',
      'registry.json',
      '--state-dir',
      'flagged',
    ],
    {},
    io,
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    "atc-gateway: --port takes a port from 1 to 65535, not 'abc'",
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runGateway).not.toHaveBeenCalled();
});

test.each([
  { args: ['clients'] },
  { args: ['clients', 'list'] },
  {
    args: ['clients', 'add', 'Claude', '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback'],
  },
  { args: ['clients', 'remove', 'client-1'] },
])('it exits 1 on $args with no state directory', async (row) => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(row.args, {}, io);

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR',
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runClients).not.toHaveBeenCalled();
});

test('it prints the usage of the command --help follows and exits 0', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(['--state-dir', 'flagged', 'clients', 'add', '--help'], {}, io);

  expect(io.print).toHaveBeenCalledExactlyOnceWith(
    expect.toInclude('Add a client and print its client ID (clients add)'),
  );

  expect(io.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(io.runClients).not.toHaveBeenCalled();
});

test('it prints the usage and the reason and exits 1 on a missing required flag', async () => {
  const io = {
    runGateway: mock(),
    runClients: mock(),
    print: mock(),
    printError: mock(),
    exit: mock(),
  };

  await runGatewayCLI(['--state-dir', 'flagged', 'serve', '--registry', 'registry.json'], {}, io);

  expect(io.print).toHaveBeenCalledExactlyOnceWith(
    expect.toInclude('Serve MCP over HTTP behind OAuth (atc-gateway serve'),
  );

  expect(io.printError).toHaveBeenCalledExactlyOnceWith('Missing required argument: --public-url');
  expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(io.runGateway).not.toHaveBeenCalled();
});
