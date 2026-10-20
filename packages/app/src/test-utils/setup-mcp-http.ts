import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import type { DaemonHandle } from '@atc/daemon';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  registerTestCleanup,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
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

export async function setupMCPHTTP(options: MCPHTTPSetupOptions = {}) {
  const temporaryDirectory = setupTempDir('atc-mcp-http-');

  // Registered after the directory, so it releases first: each part stops
  // before the one it depends on, and the directory goes last.
  const stack = new AsyncDisposableStack();

  const teardown = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(temporaryDirectory.teardown);

  const socketPath = join(temporaryDirectory.path, 'daemon.sock');
  const stateDir = join(temporaryDirectory.path, '.local', 'state', 'atc');

  mkdirSync(stateDir, { recursive: true });

  const dbPath = join(stateDir, 'mcp-auth.db');
  const requests: string[] = [];
  const security: string[] = [];

  const startTestDaemon = (principals: ReadonlyMap<string, readonly string[]> | null = null) =>
    startDaemon({
      socketPath,
      reporterSocketPath: join(temporaryDirectory.path, 'reporter.sock'),
      build: 'atc/test-build',
      targets: [buildLocalTarget()],
      adapter: buildMockAgentAdapter(),
      dbPath: join(temporaryDirectory.path, 'state.db'),
      statusPath: join(temporaryDirectory.path, 'status.json'),
      principals,
    });

  let daemon: DaemonHandle = await startTestDaemon();

  stack.defer(() => daemon.stop());

  const caller = new TransportCaller(socketPath, 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  stack.defer(() => caller.stop());

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: options.allowedHosts ?? [],
    trustForwardedFrom: [],
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
    home: temporaryDirectory.path,
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
