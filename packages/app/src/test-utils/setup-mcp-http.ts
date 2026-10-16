import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/wire';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  registerTestCleanup,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
import { startDaemon } from '../daemon/daemon';
import type { DaemonHandle } from '../daemon/daemon';
import { createEnrollmentToken } from '../mcp/create-enrollment-token';
import { openMCPAuth } from '../mcp/open-mcp-auth';
import { startMCPHTTPServer } from '../mcp/start-mcp-http-server';
import { TransportCaller } from '../mcp/transport-caller';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { buildLocalTarget } from './build-local-target';

interface MCPHTTPSetupOptions {
  // Further Host header values the server accepts.
  readonly allowedHosts?: readonly string[];
}

/**
 * A real daemon in a temp directory and `atc mcp --http` in front of it on a
 * free port, with the owner's passkey enrolled on `authenticator` through
 * the server's enrollment page, and every request line and security event
 * line the server prints after that collected. The authorization server's database sits where atc keeps it
 * under `home`, so a CLI run with that home opens the same file. `store` is
 * the authorization server's database opened a second time the way
 * `atc clients` and `atc grants` open it, and `createClient` adds a client
 * through it and returns the client id. `restartDaemon` stops the daemon and
 * starts a fresh one on the same socket and database, the way an operator
 * restarts it, with the principals it is given; `countDaemonClients` reads
 * how many connections the current daemon holds open. Everything it starts
 * stops, and the directory is removed, once the current test finishes, so it
 * must run inside a test; `teardown` does so sooner, and a second teardown
 * does nothing.
 */
export async function setupMCPHTTP(options: MCPHTTPSetupOptions = {}) {
  const tmp = setupTempDir('atc-mcp-http-');

  // Registered after the directory, so it releases first: each part stops
  // before the one it depends on, and the directory goes last.
  const stack = new AsyncDisposableStack();

  const teardown = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(tmp.teardown);

  const socketPath = join(tmp.dir, 'daemon.sock');
  const stateDir = join(tmp.dir, '.local', 'state', 'atc');

  mkdirSync(stateDir, { recursive: true });

  const dbPath = join(stateDir, 'mcp-auth.db');
  const requests: string[] = [];
  const security: string[] = [];

  const startTestDaemon = (principals: ReadonlyMap<string, readonly string[]> | null = null) =>
    startDaemon({
      socketPath,
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      targets: [buildLocalTarget()],
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      principals,
    });

  let daemon: DaemonHandle = await startTestDaemon();

  stack.defer(() => daemon.stop());

  const caller = new TransportCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: options.allowedHosts ?? [],
    dbPath,
    openAuthDatabase: openMCPAuthDatabase,
    printRequest: (line) => {
      requests.push(line);
    },
    printSecurity: (line) => {
      security.push(line);
    },
  });

  stack.defer(() => server.stop());

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  stack.defer(() => store.close());

  const authenticator = buildStubAuthenticator();

  const enrollment = await createEnrollmentToken(store.db, Date.now());

  await runPasskeyEnrollment(server, enrollment.token, authenticator);

  // The lines the enrollment printed are not part of any scenario.
  requests.length = 0;
  security.length = 0;

  return {
    home: tmp.dir,
    url: server.url,
    origin: server.origin,
    dbPath,
    authenticator,
    requests,
    security,
    caller,
    store,
    async createClient(name: string, redirectURIs: readonly string[]): Promise<string> {
      const created = await store.auth.api.createFixedClient({
        body: { name, redirectURIs: [...redirectURIs] },
      });

      return created.clientID;
    },
    countDaemonClients() {
      return daemon.countClients();
    },
    async restartDaemon(principals: ReadonlyMap<string, readonly string[]> | null = null) {
      await daemon.stop();

      daemon = await startTestDaemon(principals);
    },
    teardown,
  };
}
