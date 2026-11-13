import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_VERSION } from '@atc/gateway/version';
import { runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import pkg from '../package.json';
import { buildGatewayStatePaths } from './build-gateway-state-paths';
import { runGatewayCLI } from './run-gateway-cli';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-gateway-cli-');

  return {
    directory: temporaryDirectory.path,
    io: {
      runGateway: mock(),
      runClients: mock(),
      runPasskeys: mock(),
      print: mock(),
      printError: mock(),
      exit: mock(),
    },
  };
}

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
    const ctx = setupTest();

    await runGatewayCLI(
      [
        ...row.before,
        'Claude',
        '--redirect-uri',
        'https://claude.ai/api/mcp/auth_callback',
        ...row.after,
      ],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
      ctx.io,
    );

    expect(ctx.io.runClients).toHaveBeenCalledExactlyOnceWith(
      { kind: 'add', name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
      { dbPath: buildGatewayStatePaths('flagged').mcpAuthDBFile, command: 'atc-gateway clients' },
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
  const ctx = setupTest();

  await runGatewayCLI(row.args, { ATC_GATEWAY_STATE_DIR: 'from-env' }, ctx.io);

  expect(ctx.io.runClients).toHaveBeenCalledExactlyOnceWith(
    { kind: 'list' },
    { dbPath: buildGatewayStatePaths('flagged').mcpAuthDBFile, command: 'atc-gateway clients' },
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
    const ctx = setupTest();

    await runGatewayCLI(
      [...row.before, 'client-1', ...row.after],
      { ATC_GATEWAY_STATE_DIR: 'from-env' },
      ctx.io,
    );

    expect(ctx.io.runClients).toHaveBeenCalledExactlyOnceWith(
      { kind: 'remove', client: 'client-1' },
      { dbPath: buildGatewayStatePaths('flagged').mcpAuthDBFile, command: 'atc-gateway clients' },
    );
  },
);

test.each([
  { args: ['--state-dir', 'flagged', 'serve'] },
  { args: ['--state-dir=flagged', 'serve'] },
  { args: ['serve', '--state-dir', 'flagged'] },
  { args: ['serve', '--state-dir=flagged'] },
])('it serves from the state directory in $args over the environment', async (row) => {
  const ctx = setupTest();

  await runGatewayCLI(
    [...row.args, '--public-url', 'https://atc.example.com', '--registry', 'registry.json'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    ctx.io,
  );

  expect(ctx.io.runGateway).toHaveBeenCalledExactlyOnceWith(`atc-gateway/${GATEWAY_VERSION}`, {
    host: '127.0.0.1',
    port: 8414,
    publicURL: 'https://atc.example.com',
    trustForwardedFrom: [],
    registryPath: 'registry.json',
    stateDir: 'flagged',
    serviceTokenFile: null,
  });
});

test('it exits 1 when it serves with no state directory', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    ['serve', '--public-url', 'https://atc.example.com', '--registry', 'registry.json'],
    {},
    ctx.io,
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR',
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runGateway).not.toHaveBeenCalled();
});

test('it exits 1 on two state directories that differ', async () => {
  const ctx = setupTest();

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
    ctx.io,
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    "atc-gateway: --state-dir gives different directories: 'first', 'second'",
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 when a flag takes the state directory flag as its value', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    ['clients', 'add', 'Claude', '--redirect-uri', '--state-dir', 'flagged'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    ctx.io,
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    "Optional argument '--redirect-uri' requires a value",
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 on a flag it does not know at the root', async () => {
  const ctx = setupTest();

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
    ctx.io,
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith('Unknown option: --stat-dir');
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it exits 1 on a port it cannot parse', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    [
      'serve',
      '--port',
      'abc',
      '--public-url',
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--state-dir',
      'flagged',
    ],
    {},
    ctx.io,
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith("Expected an integer, got 'abc'");
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runGateway).not.toHaveBeenCalled();
});

test('it serves on port 0 for the kernel to pick a free port', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    [
      'serve',
      '--port',
      '0',
      '--public-url',
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--state-dir',
      'flagged',
    ],
    {},
    ctx.io,
  );

  expect(ctx.io.runGateway).toHaveBeenCalledExactlyOnceWith(`atc-gateway/${GATEWAY_VERSION}`, {
    host: '127.0.0.1',
    port: 0,
    publicURL: 'https://atc.example.com',
    trustForwardedFrom: [],
    registryPath: 'registry.json',
    stateDir: 'flagged',
    serviceTokenFile: null,
  });
});

test('it serves trusting every proxy address that --trust-forwarded-from repeats', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    [
      'serve',
      '--public-url',
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--state-dir',
      'flagged',
      '--trust-forwarded-from',
      '127.0.0.1',
      '--trust-forwarded-from',
      '::1',
    ],
    {},
    ctx.io,
  );

  expect(ctx.io.runGateway).toHaveBeenCalledExactlyOnceWith(`atc-gateway/${GATEWAY_VERSION}`, {
    host: '127.0.0.1',
    port: 8414,
    publicURL: 'https://atc.example.com',
    trustForwardedFrom: ['127.0.0.1', '::1'],
    registryPath: 'registry.json',
    stateDir: 'flagged',
    serviceTokenFile: null,
  });
});

test('it serves with the service token file that --service-token-file names', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    [
      'serve',
      '--public-url',
      'https://atc.example.com',
      '--registry',
      'registry.json',
      '--state-dir',
      'flagged',
      '--service-token-file',
      'service-tokens.json',
    ],
    {},
    ctx.io,
  );

  expect(ctx.io.runGateway).toHaveBeenCalledExactlyOnceWith(`atc-gateway/${GATEWAY_VERSION}`, {
    host: '127.0.0.1',
    port: 8414,
    publicURL: 'https://atc.example.com',
    trustForwardedFrom: [],
    registryPath: 'registry.json',
    stateDir: 'flagged',
    serviceTokenFile: 'service-tokens.json',
  });
});

test.each([
  { args: ['clients'] },
  { args: ['clients', 'list'] },
  {
    args: ['clients', 'add', 'Claude', '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback'],
  },
  { args: ['clients', 'remove', 'client-1'] },
])('it exits 1 on $args with no state directory', async (row) => {
  const ctx = setupTest();

  await runGatewayCLI(row.args, {}, ctx.io);

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR',
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it prints the usage of the command --help follows and exits 0', async () => {
  const ctx = setupTest();

  await runGatewayCLI(['--state-dir', 'flagged', 'clients', 'add', '--help'], {}, ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(
    expect.toInclude('atc-gateway clients add <OPTIONS> <name>'),
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it prints the usage and the reason and exits 1 on a missing required flag', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    ['--state-dir', 'flagged', 'serve', '--registry', 'registry.json'],
    {},
    ctx.io,
  );

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(
    expect.toInclude('atc-gateway serve <OPTIONS>'),
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    "Optional argument '--public-url' is required",
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runGateway).not.toHaveBeenCalled();
});

test.each([
  { args: ['passkeys'], action: { kind: 'list' } },
  { args: ['passkeys', 'list'], action: { kind: 'list' } },
  { args: ['passkeys', 'enroll'], action: { kind: 'enroll', reset: false } },
  { args: ['passkeys', 'enroll', '--reset'], action: { kind: 'enroll', reset: true } },
  { args: ['passkeys', 'remove', 'cred-1'], action: { kind: 'remove', id: 'cred-1' } },
])('it hands $args to the passkey command for the state directory', async (row) => {
  const ctx = setupTest();

  await runGatewayCLI([...row.args, '--state-dir', 'flagged'], {}, ctx.io);

  expect(ctx.io.runPasskeys).toHaveBeenCalledExactlyOnceWith(row.action, {
    dbPath: buildGatewayStatePaths('flagged').mcpAuthDBFile,
    command: 'atc-gateway passkeys',
  });
});

test('it adds a client with every redirect URI, in order, in either flag form', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    [
      'clients',
      'add',
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--redirect-uri=https://claude.com/api/mcp/auth_callback',
      '--state-dir',
      'flagged',
    ],
    {},
    ctx.io,
  );

  expect(ctx.io.runClients).toHaveBeenCalledExactlyOnceWith(
    {
      kind: 'add',
      name: 'Claude',
      redirectURIs: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    },
    { dbPath: buildGatewayStatePaths('flagged').mcpAuthDBFile, command: 'atc-gateway clients' },
  );
});

test('it exits 1 on an empty state directory flag', async () => {
  const ctx = setupTest();

  await runGatewayCLI(['clients', '--state-dir='], { ATC_GATEWAY_STATE_DIR: 'from-env' }, ctx.io);

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: --state-dir needs a value; write --state-dir=<value>',
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test.each([{ args: [] }, { args: ['--state-dir', 'flagged'] }])(
  'it prints the usage and exits 1 on $args, which names no command',
  async (row) => {
    const ctx = setupTest();

    await runGatewayCLI(row.args, {}, ctx.io);

    expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(
      expect.toInclude('atc-gateway [COMMANDS]'),
    );

    expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith('No command specified.');
    expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);

test('it exits 1 on a command it does not know', async () => {
  const ctx = setupTest();

  await runGatewayCLI(['clients', 'rename', '--state-dir', 'flagged'], {}, ctx.io);

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith('Command not found: rename');
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runClients).not.toHaveBeenCalled();
});

test('it reports the gateway manifest version, not the app manifest version, in --version and serve by default', async () => {
  const ctx = setupTest();
  const preload = join(ctx.directory, 'gateway-manifest.ts');
  const script = join(ctx.directory, 'run.ts');

  // Serves the gateway package's manifest at 9.1.0 while the app's stays at
  // its own version, so the run shows which manifest the CLI read. Bun's
  // plugin json loader refuses this content, so the manifest loads as a module.
  writeFileSync(
    preload,
    [
      'Bun.plugin({',
      "  name: 'gateway-manifest',",
      '  setup(build) {',
      String.raw`    build.onLoad({ filter: /packages[/\\]gateway[/\\]package\.json$/ }, () => ({`,
      `      contents: "export default { name: '@atc/gateway', version: '9.1.0' };",`,
      "      loader: 'js',",
      '    }));',
      '  },',
      '});',
      '',
    ].join('\n'),
  );

  writeFileSync(
    script,
    [
      `import { runGatewayCLI } from ${JSON.stringify(join(import.meta.dir, 'run-gateway-cli.ts'))};`,
      'const lines = [];',
      'const io = {',
      '  runGateway: async (build) => { lines.push(build); },',
      '  runClients: async () => {},',
      '  runPasskeys: async () => {},',
      '  print: (line) => { lines.push(line); },',
      '  printError: (line) => { lines.push(line); },',
      '  exit: () => {},',
      '};',
      "await runGatewayCLI(['--version'], {}, io);",
      "await runGatewayCLI(['serve', '--public-url', 'https://atc.example.com', '--registry', 'registry.json', '--state-dir', 'state'], {}, io);",
      'console.log(JSON.stringify(lines));',
      '',
    ].join('\n'),
  );

  invariant(pkg.version !== '9.1.0', 'the app manifest must hold another version than 9.1.0');

  const ran = await runCommand(['bun', '--preload', preload, script], { cwd: ctx.directory });

  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '["9.1.0","atc-gateway/9.1.0"]\n',
  });
});

test('it prints the version it is given, not the app package version, on --version', async () => {
  const ctx = setupTest();

  await runGatewayCLI(['--version'], {}, ctx.io, '9.1.0');

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith('9.1.0');
});

test('it serves under the build of the version it is given, not the app package version', async () => {
  const ctx = setupTest();

  await runGatewayCLI(
    ['serve', '--public-url', 'https://atc.example.com', '--registry', 'registry.json'],
    { ATC_GATEWAY_STATE_DIR: 'from-env' },
    ctx.io,
    '9.1.0',
  );

  expect(ctx.io.runGateway).toHaveBeenCalledExactlyOnceWith('atc-gateway/9.1.0', {
    host: '127.0.0.1',
    port: 8414,
    publicURL: 'https://atc.example.com',
    trustForwardedFrom: [],
    registryPath: 'registry.json',
    stateDir: 'from-env',
    serviceTokenFile: null,
  });
});

test("it prints the gateway package's version and exits 0 on --version", async () => {
  const ctx = setupTest();

  await runGatewayCLI(['--version'], {}, ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(GATEWAY_VERSION);
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('it exits 1 when it enrolls a passkey with no state directory', async () => {
  const ctx = setupTest();

  await runGatewayCLI(['passkeys', 'enroll'], {}, ctx.io);

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(
    'atc-gateway: give --state-dir or set ATC_GATEWAY_STATE_DIR',
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.io.runPasskeys).not.toHaveBeenCalled();
});
