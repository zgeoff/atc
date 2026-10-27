import { expect, mock, test } from 'bun:test';
import pkg from '../package.json';
import { runATCCLI } from './run-atc-cli';

function setupTest() {
  return {
    io: {
      runTUI: mock(() => Promise.resolve()),
      runMCP: mock(() => Promise.resolve()),
      runClients: mock(() => Promise.resolve()),
      runPasskeys: mock(() => Promise.resolve()),
      runSession: mock(() => Promise.resolve()),
      runGrants: mock(() => Promise.resolve()),
      runConfigMigrate: mock(() => Promise.resolve()),
      runDaemon: mock(() => Promise.resolve()),
      runDaemonID: mock(() => Promise.resolve()),
      runDaemonRestart: mock(() => Promise.resolve()),
      runDaemonRestartWorker: mock(() => Promise.resolve()),
      runBackup: mock(() => Promise.resolve()),
      runEvents: mock(() => Promise.resolve()),
      printCodexHooks: mock(() => Promise.resolve()),
      printGrokHooks: mock(() => Promise.resolve()),
      runHookReport: mock(() => Promise.resolve()),
      runTap: mock(() => Promise.resolve()),
      runNote: mock(() => Promise.resolve()),
      runStatusline: mock(() => Promise.resolve()),
      print: mock(),
      printError: mock(),
      exit: mock(),
    },
  };
}

test.each([
  { args: [], run: 'runTUI', with: [null] },
  { args: ['--daemon', 'box'], run: 'runTUI', with: ['box'] },
  { args: ['tui', '--daemon=box'], run: 'runTUI', with: ['box'] },
  {
    args: ['mcp'],
    run: 'runMCP',
    with: [
      {
        http: false,
        host: null,
        port: null,
        publicURL: null,
        waitForDaemon: false,
        tokenFile: null,
        allowedOrigins: [],
      },
    ],
  },
  {
    args: [
      'mcp',
      '--http',
      '--host',
      '0.0.0.0',
      '--port=0',
      '--public-url',
      'https://mcp.example.com',
      '--wait-for-daemon',
      '--token-file',
      'viewer-token',
      '--allowed-origin',
      'https://panel.example.com',
      '--allowed-origin=http://localhost:5173',
    ],
    run: 'runMCP',
    with: [
      {
        http: true,
        host: '0.0.0.0',
        port: 0,
        publicURL: 'https://mcp.example.com',
        waitForDaemon: true,
        tokenFile: 'viewer-token',
        allowedOrigins: ['https://panel.example.com', 'http://localhost:5173'],
      },
    ],
  },
  { args: ['clients'], run: 'runClients', with: [{ kind: 'list' }] },
  { args: ['clients', 'list'], run: 'runClients', with: [{ kind: 'list' }] },
  {
    args: ['clients', 'add', 'Claude', '--redirect-uri', 'https://a.example', '--redirect-uri=b'],
    run: 'runClients',
    with: [{ kind: 'add', name: 'Claude', redirectURIs: ['https://a.example', 'b'] }],
  },
  {
    args: ['clients', 'remove', 'client-1'],
    run: 'runClients',
    with: [{ kind: 'remove', clientID: 'client-1' }],
  },
  { args: ['passkeys'], run: 'runPasskeys', with: [{ kind: 'list' }] },
  { args: ['passkeys', 'list'], run: 'runPasskeys', with: [{ kind: 'list' }] },
  { args: ['passkeys', 'enroll'], run: 'runPasskeys', with: [{ kind: 'enroll', reset: false }] },
  {
    args: ['passkeys', 'enroll', '--reset'],
    run: 'runPasskeys',
    with: [{ kind: 'enroll', reset: true }],
  },
  {
    args: ['passkeys', 'remove', 'cred-1'],
    run: 'runPasskeys',
    with: [{ kind: 'remove', id: 'cred-1' }],
  },
  { args: ['session', 'rebind', 's-1'], run: 'runSession', with: ['rebind', 's-1'] },
  { args: ['session', 'adopt', 's-1'], run: 'runSession', with: ['adopt', 's-1'] },
  { args: ['grants'], run: 'runGrants', with: [null] },
  { args: ['grants', '--revoke', 'grant-1'], run: 'runGrants', with: ['grant-1'] },
  { args: ['grants', '--revoke=-a_b'], run: 'runGrants', with: ['-a_b'] },
  { args: ['config', 'migrate'], run: 'runConfigMigrate', with: [null, false] },
  {
    args: ['config', 'migrate', '--write', '--file', 'old.json'],
    run: 'runConfigMigrate',
    with: ['old.json', true],
  },
  { args: ['daemon'], run: 'runDaemon', with: [null, null] },
  {
    args: ['daemon', '--listen', '127.0.0.1:7000', '--token-file', 'tokens'],
    run: 'runDaemon',
    with: ['127.0.0.1:7000', 'tokens'],
  },
  {
    args: ['daemon', 'serve', '--listen=127.0.0.1:7000', '--token-file=tokens'],
    run: 'runDaemon',
    with: ['127.0.0.1:7000', 'tokens'],
  },
  { args: ['daemon', 'id'], run: 'runDaemonID', with: [] },
  {
    args: ['daemon', 'restart'],
    run: 'runDaemonRestart',
    with: [{ listen: null, tokenFile: null, timeout: null, dryRun: false }],
  },
  {
    args: [
      'daemon',
      'restart',
      '--listen',
      '127.0.0.1:7000',
      '--token-file',
      'tokens',
      '--timeout',
      '30',
      '--dry-run',
    ],
    run: 'runDaemonRestart',
    with: [{ listen: '127.0.0.1:7000', tokenFile: 'tokens', timeout: '30', dryRun: true }],
  },
  {
    args: ['daemon', 'restart-worker', 'run-1'],
    run: 'runDaemonRestartWorker',
    with: [{ listen: null, tokenFile: null, timeout: null, runID: 'run-1', session: null }],
  },
  {
    args: [
      'daemon',
      'restart-worker',
      'run-1',
      '--session',
      's-1',
      '--timeout',
      '30',
      '--listen',
      '127.0.0.1:7000',
      '--token-file',
      'tokens',
    ],
    run: 'runDaemonRestartWorker',
    with: [
      {
        listen: '127.0.0.1:7000',
        tokenFile: 'tokens',
        timeout: '30',
        runID: 'run-1',
        session: 's-1',
      },
    ],
  },
  { args: ['backup', 'state.db'], run: 'runBackup', with: ['state.db'] },
  { args: ['events'], run: 'runEvents', with: [] },
  { args: ['codex-hooks'], run: 'printCodexHooks', with: [] },
  { args: ['grok-hooks'], run: 'printGrokHooks', with: [] },
  { args: ['hook-report'], run: 'runHookReport', with: [''] },
  { args: ['hook-report', '--agent', 'claude'], run: 'runHookReport', with: ['claude'] },
  { args: ['hook-report', '--agent=-custom'], run: 'runHookReport', with: ['-custom'] },
  { args: ['statusline', '--agent=-custom'], run: 'runStatusline', with: ['-custom'] },
  { args: ['tap', '--session', 's-1'], run: 'runTap', with: ['s-1', false] },
  { args: ['tap', '--session=s-1', '--notices'], run: 'runTap', with: ['s-1', true] },
  {
    args: ['note', '--label', 'progress'],
    run: 'runNote',
    with: ['note', { message: '', messages: '', label: 'progress', turn: '' }],
  },
  {
    args: ['answer', '--message', 'm-1', '--messages', 'm-1,m-2', '--turn', 't-1'],
    run: 'runNote',
    with: ['answered', { message: 'm-1', messages: 'm-1,m-2', label: '', turn: 't-1' }],
  },
  {
    args: ['unanswered', '--messages', 'm-1', '--turn', 't-1', '--reason', 'stopped'],
    run: 'runNote',
    with: [
      'unanswered',
      { message: '', messages: 'm-1', label: '', turn: 't-1', reason: 'stopped' },
    ],
  },
  { args: ['statusline'], run: 'runStatusline', with: [''] },
  { args: ['statusline', '--agent', 'grok'], run: 'runStatusline', with: ['grok'] },
] as const)('it hands $args to $run with the flags it parsed', async (row) => {
  const ctx = setupTest();

  await runATCCLI(row.args, ctx.io);

  expect(ctx.io[row.run]).toHaveBeenCalledExactlyOnceWith(...row.with);
  expect(ctx.io.exit).not.toHaveBeenCalled();
});

test.each([
  { args: ['hook-report', '--frobnicate'] },
  { args: ['hook-report', '--agent'] },
  { args: ['statusline', '--frobnicate'] },
  { args: ['note', '--frobnicate'] },
  { args: ['answer', '--turn'] },
  { args: ['unanswered', '--frobnicate'] },
])('it exits 0 without reporting on $args, a reporter command line it refuses', async (row) => {
  const ctx = setupTest();

  await runATCCLI(row.args, ctx.io);

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(ctx.io.runHookReport).not.toHaveBeenCalled();
  expect(ctx.io.runStatusline).not.toHaveBeenCalled();
  expect(ctx.io.runNote).not.toHaveBeenCalled();
});

test.each([
  { args: ['frobnicate'], reason: 'Command not found: frobnicate' },
  { args: ['daemon', '--frobnicate'], reason: 'Unknown option: --frobnicate' },
  { args: ['mcp', '--port', '65536'], reason: 'Integer must be <= 65535, got 65536' },
  { args: ['backup'], reason: "Positional argument 'path' is required" },
  { args: ['tap'], reason: "Optional argument '--session' is required" },
  {
    args: ['grants', '--revoke', '-a_b'],
    reason: expect.toStartWith("Optional argument '--revoke' requires a value"),
  },
])('it prints the usage and the reason and exits 1 on $args', async (row) => {
  const ctx = setupTest();

  await runATCCLI(row.args, ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(expect.toInclude('USAGE:'));
  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith(row.reason);
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('it lists the commands it has when the command line names one it does not', async () => {
  const ctx = setupTest();

  await runATCCLI(['clients', 'rename'], ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/add <OPTIONS> <name> +Add a client and print its client ID/u),
  );

  expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith('Command not found: rename');
});

test.each([{ args: ['session'] }, { args: ['config'] }])(
  'it prints the usage and exits 1 on $args, which names no command',
  async (row) => {
    const ctx = setupTest();

    await runATCCLI(row.args, ctx.io);

    expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(expect.toInclude('USAGE:'));
    expect(ctx.io.printError).toHaveBeenCalledExactlyOnceWith('No command specified.');
    expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);

test('it prints the usage of the command --help follows and exits 0', async () => {
  const ctx = setupTest();

  await runATCCLI(['daemon', 'restart', '--help'], ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(
    expect.toInclude('atc daemon restart <OPTIONS>'),
  );

  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(ctx.io.runDaemonRestart).not.toHaveBeenCalled();
});

test('it prints the version and exits 0 on --version', async () => {
  const ctx = setupTest();

  await runATCCLI(['--version'], ctx.io);

  expect(ctx.io.print).toHaveBeenCalledExactlyOnceWith(pkg.version);
  expect(ctx.io.exit).toHaveBeenCalledExactlyOnceWith(0);
});
