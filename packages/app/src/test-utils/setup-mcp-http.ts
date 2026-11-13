import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { systemClock } from '@atc/core';
import { startDaemon } from '@atc/daemon';
import type { DaemonHandle } from '@atc/daemon';
import { createTransportCaller, openATCAuthAdmin, startMCPHTTPServer } from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  registerTestCleanup,
  runPasskeyEnrollment,
  setupTempDir,
} from '@atc/test-utils';
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
  const paths = resolvePaths({ HOME: temporaryDirectory.path });

  mkdirSync(paths.stateDir, { recursive: true });

  const dbPath = paths.mcpAuthDBFile;
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

  const caller = createTransportCaller(socketPath, 'atc/test-build', (path) =>
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

  const sqlite = openMCPAuthDatabase(dbPath);

  stack.defer(() => {
    sqlite.close();
  });

  const admin = await openATCAuthAdmin(sqlite, systemClock);

  stack.defer(() => admin.close());

  const authenticator = buildStubAuthenticator();

  const enrollmentToken = await admin.passkeys.createEnrollmentToken();

  await runPasskeyEnrollment(server, enrollmentToken, authenticator);

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
    admin,
    async createClient(name: string, redirectURIs: readonly string[]): Promise<string> {
      const created = await admin.clients.add(name, redirectURIs);

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
