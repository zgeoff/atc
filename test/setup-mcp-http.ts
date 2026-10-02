import { join } from 'node:path';
import type { AgentAdapter } from '../src/agents/agent-adapter';
import { startDaemon } from '../src/daemon/daemon';
import type { DaemonHandle } from '../src/daemon/daemon';
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

/**
 * A real daemon in a temp directory and `atc mcp --http` in front of it on a
 * free port, with every approval line the server prints collected.
 * `restartDaemon` stops the daemon and starts a fresh one on the same socket
 * and database, the way an operator restarts it. Hold the result with
 * `await using`.
 */
export async function setupMCPHTTP() {
  const tmp = setupTempDir('atc-mcp-http-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const approvals: string[] = [];

  const startTestDaemon = () =>
    startDaemon({
      socketPath,
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: SLEEP_ADAPTER,
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
    });

  let daemon: DaemonHandle = await startTestDaemon();

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build');

  const server = startMCPHTTPServer({
    caller,
    build: 'atc/test-build',
    port: 0,
    publicURL: null,
    allowedHosts: [],
    metadataHosts: [],
    printApproval: (line) => {
      approvals.push(line);
    },
  });

  return {
    url: server.url,
    origin: server.origin,
    approvals,
    caller,
    async restartDaemon() {
      await daemon.stop();

      daemon = await startTestDaemon();
    },
    async [Symbol.asyncDispose]() {
      await server.stop();
      await caller.stop();
      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}
