import { expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NODE_TOKEN_FILE_ACCESS, loadListenerTokens } from '@atc/config';
import { startDaemon } from '@atc/daemon';
import { bootDaemonClient } from '@atc/lifecycle';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { openMCPAuth } from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  openPTYViewer,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { runMCPHTTPServer } from './mcp-http-server';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { buildLocalTarget } from './test-utils/build-local-target';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-mcp-http-server-');
  const socketPath = join(temporaryDirectory.path, 'atc-daemon.sock');

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(temporaryDirectory.path, 'reporter.sock'),
    build: 'atc/test-build',
    targets: [buildLocalTarget()],
    adapter: buildMockAgentAdapter(),
    dbPath: join(temporaryDirectory.path, 'state.db'),
    statusPath: join(temporaryDirectory.path, 'status.json'),
  });

  registerTestCleanup(() => daemon.stop());

  return {
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    daemonPaths: {
      socketPath,
      recordFile: join(temporaryDirectory.path, 'daemon.json'),
      pidFile: join(temporaryDirectory.path, 'atc-daemon.pid'),
    },
  };
}

test('it serves MCP through the daemon it boots and says no client can connect and no passkey is enrolled yet', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const requests: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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
    'No passkey is enrolled, so nobody can sign in yet. Enroll one with: atc passkeys enroll',
  ]);

  expect(served.status).toBe(401);
  expect(requests.join('\n')).toMatch(/^POST \/mcp 401 \d+ms$/u);
});

test('it trusts the forwarded address from a proxy the config lists', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: ['127.0.0.1'],
      }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
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

  await fetch(`http://127.0.0.1:${port}/oauth2/authorize?client_id=no-such-client`, {
    headers: { 'cf-connecting-ip': '198.51.100.23' },
    redirect: 'manual',
  });

  expect(
    JSON.parse(
      `[${errors
        .filter((line) => line.startsWith('atc security '))
        .map((line) => line.slice('atc security '.length))
        .join(',')}]`,
    ),
  ).toMatchObject([
    {
      kind: 'authorize_invalid',
      forwarded: { address: '198.51.100.23', header: 'cf-connecting-ip', provenance: 'trusted' },
    },
  ]);
});

test('it leaves the forwarded address unverified from a peer the config does not list', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: ['192.0.2.1'],
      }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
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

  await fetch(`http://127.0.0.1:${port}/oauth2/authorize?client_id=no-such-client`, {
    headers: { 'cf-connecting-ip': '198.51.100.23' },
    redirect: 'manual',
  });

  expect(
    JSON.parse(
      `[${errors
        .filter((line) => line.startsWith('atc security '))
        .map((line) => line.slice('atc security '.length))
        .join(',')}]`,
    ),
  ).toMatchObject([
    {
      kind: 'authorize_invalid',
      forwarded: {
        address: '198.51.100.23',
        header: 'cf-connecting-ip',
        provenance: 'unverified',
      },
    },
  ]);
});

test('it prints no hint to add a client once one can connect', async () => {
  const ctx = await setupTest();

  const store = await openMCPAuth({
    dbPath: ctx.dbPath,
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  await store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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
    /^atc mcp --http: serving http:\/\/127\.0\.0\.1:\d+\/mcp, listening on http:\/\/127\.0\.0\.1:\d+\nNo passkey is enrolled, so nobody can sign in yet\. Enroll one with: atc passkeys enroll$/u,
  );
});

test('it prints no hint to enroll a passkey once one is enrolled', async () => {
  const ctx = await setupTest();

  const store = await openMCPAuth({
    dbPath: ctx.dbPath,
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  await store.db
    .insertInto('atc_passkey')
    .values({
      id: 'cred-phone',
      public_key: 'AQID',
      counter: 0,
      transports: '[]',
      created_at: '2026-10-14T12:00:00.000Z',
      last_used_at: null,
    })
    .execute();

  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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
    /^atc mcp --http: serving http:\/\/127\.0\.0\.1:\d+\/mcp, listening on http:\/\/127\.0\.0\.1:\d+\nNo clients can connect yet\. Add one with: atc clients add <name> --redirect-uri <uri>$/u,
  );
});

test('it prints nothing to stdout once it serves and each sign-in security event to stderr', async () => {
  const ctx = await setupTest();

  const store = await openMCPAuth({
    dbPath: ctx.dbPath,
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  const created = await store.auth.api.createFixedClient({
    body: { name: 'Claude', redirectURIs: ['https://claude.ai/api/mcp/auth_callback'] },
  });

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
      dbPath: ctx.dbPath,
      daemonPaths: ctx.daemonPaths,
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
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

  const startup = [...printed];

  const authorize = new URL(`http://127.0.0.1:${port}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual' });

  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { host: 'rebound.example' },
  });

  expect(printed).toStrictEqual(startup);

  expect(errors.filter((line) => line.startsWith('atc security '))).toIncludeSameMembers([
    expect.stringMatching(
      /^atc security \{"version":1,.*"kind":"authorize_started","outcome":"accepted"/u,
    ),
    expect.stringMatching(
      /^atc security \{"version":1,.*"kind":"authorize_invalid".*"reason":"bad_host"/u,
    ),
  ]);
});

test('it registers its SIGINT and SIGTERM handlers before it prints the serving line', async () => {
  const ctx = await setupTest();

  const happened: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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
    /^atc mcp --http: serving http:\/\/127\.0\.0\.1:\d+\/mcp, listening on http:\/\/127\.0\.0\.1:\d+\nNo clients can connect yet\. Add one with: atc clients add <name> --redirect-uri <uri>\nNo passkey is enrolled, so nobody can sign in yet\. Enroll one with: atc passkeys enroll$/u,
  );
});

test('it stops serving and exits 0 on SIGTERM', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];
  const codes: number[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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

test('it exits 1 with the reason when no daemon answers at its daemon paths', async () => {
  const temporaryDirectory = setupTempDir('atc-mcp-http-server-');
  const errors: string[] = [];
  const codes: number[] = [];

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile: null,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
      dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
      daemonPaths: {
        socketPath: join(temporaryDirectory.path, 'atc-daemon.sock'),
        recordFile: join(temporaryDirectory.path, 'daemon.json'),
        pidFile: join(temporaryDirectory.path, 'atc-daemon.pid'),
      },
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      exit: (code) => {
        codes.push(code);
      },
      registerSignal: () => {},
    },
  );

  expect(errors).toStrictEqual([
    `atc mcp --http: no atc daemon answered at ${join(temporaryDirectory.path, 'atc-daemon.sock')}, and a boot given its own daemon paths does not start one; start \`atc daemon\` where it listens there first`,
  ]);

  expect(codes).toStrictEqual([1]);
});

test('it streams a snapshot to a viewer that presents the token from its owner-only token file', async () => {
  const ctx = await setupTest();

  const tokenFile = join(dirname(ctx.dbPath), 'viewer-token');
  const ownerToken = 'viewer-secret-4f1c-8a2d-6b9e-3c7f-0d5a';
  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await Bun.write(tokenFile, `${ownerToken}\n`);

  chmodSync(tokenFile, 0o600);

  const client = await openDaemonClient(ctx.daemonPaths.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build', {});

  const spawned = await client.procedures.session.spawn({
    cwd: dirname(ctx.dbPath),
    cols: 80,
    rows: 24,
  });

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => bootDaemonClient(buildMockLifecycleHost(), options),
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
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

  const port = /:(?<port>\d+)\/mcp,/u.exec(printed.join('\n'))?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const viewer = await openPTYViewer(`ws://127.0.0.1:${port}/sessions/${spawned.session.id}/pty`, {
    token: ownerToken,
  });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(1);
  });

  expect(viewer.frames).toStrictEqual([
    {
      kind: 'control',
      frame: expect.objectContaining({ type: 'snapshot', cols: 80, rows: 24, state: 'running' }),
    },
  ]);
});

test('it exits 1 before it boots a daemon when other users can open its token file', async () => {
  const temporaryDirectory = setupTempDir('atc-mcp-http-server-');
  const tokenFile = join(temporaryDirectory.path, 'viewer-token');
  const errors: string[] = [];
  const codes: number[] = [];
  const boots: unknown[] = [];

  await Bun.write(tokenFile, 'viewer-secret-4f1c\n');

  chmodSync(tokenFile, 0o644);

  await runMCPHTTPServer(
    'atc/test-build',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      waitForDaemon: false,
      tokenFile,
      allowedOrigins: [],
    },
    {
      bootDaemon: (options) => {
        boots.push(options);

        return bootDaemonClient(buildMockLifecycleHost(), options);
      },
      openAuthDatabase: openMCPAuthDatabase,
    },
    {
      loadTokens: (path) => loadListenerTokens(path, NODE_TOKEN_FILE_ACCESS),
      loadConfig: () => ({
        publicURL: null,
        host: '127.0.0.1',
        port: 8414,
        allowedHosts: [],
        allowedOrigins: [],
        trustForwardedFrom: [],
      }),
      dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
      daemonPaths: {
        socketPath: join(temporaryDirectory.path, 'atc-daemon.sock'),
        recordFile: join(temporaryDirectory.path, 'daemon.json'),
        pidFile: join(temporaryDirectory.path, 'atc-daemon.pid'),
      },
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      exit: (code) => {
        codes.push(code);
      },
      registerSignal: () => {},
    },
  );

  expect(errors).toStrictEqual([
    `atc mcp --http: --token-file: other users can open ${tokenFile} (mode 644); run chmod 600 ${tokenFile}`,
  ]);

  expect(codes).toStrictEqual([1]);
  expect(boots).toBeEmpty();
});
