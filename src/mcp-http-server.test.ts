import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { startDaemon } from './daemon/daemon';
import { runMCPHTTPServer } from './mcp-http-server';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { buildMockAgentAdapter } from './test-utils/build-mock-agent-adapter';
import { registerTestCleanup } from './test-utils/register-test-cleanup';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A real daemon listening in a temp directory, the files the server's boot
 * looks for it at, and the path the authorization database lands at. The
 * daemon stops, and then the directory goes, once the test finishes.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-mcp-http-server-');
  const socketPath = join(tmp.dir, 'atc-daemon.sock');

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter(),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  return {
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    daemonPaths: {
      socketPath,
      recordFile: join(tmp.dir, 'daemon.json'),
      pidFile: join(tmp.dir, 'atc-daemon.pid'),
    },
  };
}

test('it serves MCP through the daemon it boots and says no client can connect yet', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const requests: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    { host: '127.0.0.1', port: 0, publicURL: null, waitForDaemon: false },
    {
      loadConfig: () => ({ publicURL: null, host: '127.0.0.1', port: 8414, allowedHosts: [] }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        requests.push(line);
      },
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stopServing = signals.get('SIGTERM');

  invariant(stopServing, 'the server registered no SIGTERM handler');
  registerTestCleanup(stopServing);

  const port = /:(?<port>\d+)\/mcp,/u.exec(printed.join('\n'))?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const served = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });

  expect(printed).toStrictEqual([
    `atc mcp --http: serving http://127.0.0.1:${port}/mcp, listening on http://127.0.0.1:${port}`,
    'No clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>',
  ]);

  expect(served.status).toBe(401);
  expect(requests.join('\n')).toMatch(/^POST \/mcp 401 \d+ms$/u);
});

test('it prints no hint to add a client once one can connect', async () => {
  const ctx = await setupTest();
  const store = await openMCPAuth({ dbPath: ctx.dbPath, origin: null });

  registerTestCleanup(() => store.close());

  await store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    { host: '127.0.0.1', port: 0, publicURL: null, waitForDaemon: false },
    {
      loadConfig: () => ({ publicURL: null, host: '127.0.0.1', port: 8414, allowedHosts: [] }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stopServing = signals.get('SIGTERM');

  invariant(stopServing, 'the server registered no SIGTERM handler');
  registerTestCleanup(stopServing);

  expect(printed.join('\n')).toMatch(
    /^atc mcp --http: serving http:\/\/127\.0\.0\.1:\d+\/mcp, listening on http:\/\/127\.0\.0\.1:\d+$/u,
  );
});

test('it registers its SIGINT and SIGTERM handlers before it prints the serving line', async () => {
  const ctx = await setupTest();

  const happened: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    { host: '127.0.0.1', port: 0, publicURL: null, waitForDaemon: false },
    {
      loadConfig: () => ({ publicURL: null, host: '127.0.0.1', port: 8414, allowedHosts: [] }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        happened.push(line);
      },
      printError: () => {},
      exit: () => {},
      registerSignal: (signal, listener) => {
        happened.push(signal);
        signals.set(signal, listener);
      },
    },
  );

  const stopServing = signals.get('SIGTERM');

  invariant(stopServing, 'the server registered no SIGTERM handler');
  registerTestCleanup(stopServing);

  expect(happened.slice(0, 2)).toStrictEqual(['SIGINT', 'SIGTERM']);

  expect(happened.slice(2).join('\n')).toMatch(
    /^atc mcp --http: serving http:\/\/127\.0\.0\.1:\d+\/mcp, listening on http:\/\/127\.0\.0\.1:\d+\nNo clients can connect yet\. Add one with: atc clients add <name> --redirect-uri <uri>$/u,
  );
});

test('it stops serving and exits 0 on SIGTERM', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const codes: number[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    { host: '127.0.0.1', port: 0, publicURL: null, waitForDaemon: false },
    {
      loadConfig: () => ({ publicURL: null, host: '127.0.0.1', port: 8414, allowedHosts: [] }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      exit: (code) => {
        codes.push(code);
      },
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const port = /:(?<port>\d+)\/mcp,/u.exec(printed.join('\n'))?.groups?.['port'];
  const stopServing = signals.get('SIGTERM');

  invariant(
    port !== undefined && stopServing !== undefined,
    `no port or no SIGTERM handler after: ${printed.join('\n')}`,
  );

  const stop = registerTestCleanup(stopServing);

  await stop();

  expect(codes).toStrictEqual([0]);
  expect(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).rejects.toThrow();
});
