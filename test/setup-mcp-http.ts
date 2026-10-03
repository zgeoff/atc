import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../src/agents/agent-adapter';
import { DaemonClient } from '../src/client/daemon-client';
import { startDaemon } from '../src/daemon/daemon';
import type { DaemonHandle } from '../src/daemon/daemon';
import { openMCPAuth } from '../src/mcp/open-mcp-auth';
import { ReconnectingCaller } from '../src/mcp/reconnecting-caller';
import { startMCPHTTPServer } from '../src/mcp/start-mcp-http-server';
import { setupTempDir } from './setup-temp-dir';

const SLEEP_ADAPTER: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

interface MCPHTTPSetupOptions {
  // How long a rotated refresh token still answers with its successor.
  readonly refreshReuseSeconds?: number;

  // Further Host header values the server accepts.
  readonly allowedHosts?: readonly string[];
}

/**
 * A real daemon in a temp directory and `atc mcp --http` in front of it on a
 * free port, with every approval line and request line the server prints
 * collected. The authorization server's database sits where atc keeps it
 * under `home`, so a CLI run with that home opens the same file. `store` is
 * the authorization server's database opened a second time the way
 * `atc clients` and `atc grants` open it, and `addClient` adds a client
 * through it and returns the client id. `restartDaemon` stops the daemon and
 * starts a fresh one on the same socket and database, the way an operator
 * restarts it, with the principals it is given; `countDaemonClients` reads how many connections the current
 * daemon holds open. Hold the result with `await using`.
 */
export async function setupMCPHTTP(options: MCPHTTPSetupOptions = {}) {
  const tmp = setupTempDir('atc-mcp-http-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const stateDir = join(tmp.dir, '.local', 'state', 'atc');

  mkdirSync(stateDir, { recursive: true });

  const dbPath = join(stateDir, 'mcp-auth.db');
  const approvals: string[] = [];
  const requests: string[] = [];

  const startTestDaemon = (principals: ReadonlyMap<string, readonly string[]> | null = null) =>
    startDaemon({
      socketPath,
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: SLEEP_ADAPTER,
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      principals,
    });

  let daemon: DaemonHandle = await startTestDaemon();

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  const server = await startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    host: '127.0.0.1',
    port: 0,
    publicURL: null,
    allowedHosts: options.allowedHosts ?? [],
    dbPath,
    printApproval: (line) => {
      approvals.push(line);
    },
    printRequest: (line) => {
      requests.push(line);
    },
    ...(options.refreshReuseSeconds === undefined
      ? {}
      : { refreshReuseSeconds: options.refreshReuseSeconds }),
  });

  const store = await openMCPAuth({ dbPath, origin: null });

  return {
    home: tmp.dir,
    url: server.url,
    origin: server.origin,
    dbPath,
    approvals,
    requests,
    caller,
    store,
    async addClient(name: string, redirectURIs: readonly string[]): Promise<string> {
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
    async [Symbol.asyncDispose]() {
      await server.stop();
      await store.close();
      await caller.stop();
      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}
