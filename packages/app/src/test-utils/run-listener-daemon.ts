import { join } from 'node:path';
import { startDaemon } from '../daemon/daemon';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

/**
 * Runs a daemon with a TCP listener on a kernel-chosen loopback port, its
 * state under `ATC_TEST_DIR` and its token file at `gateway-token` there.
 * The listener logs through its own stderr writer, delays no handshake, and
 * logs every refusal on a line of its own. It prints the port it bound once
 * it listens, and SIGTERM stops it.
 */
async function main() {
  const dir = process.env['ATC_TEST_DIR'] ?? '';

  const handle = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: buildMockAgentAdapter({
      takesMessages: true,
      normalizeHook: () => ({ kind: 'prompt-submitted' }),
      buildResumeCommand: () => 'claude --resume',
    }),
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    listen: {
      host: '127.0.0.1',
      port: 0,
      tokenFile: join(dir, 'gateway-token'),
      failureDelayMs: 0,
      refusalLogIntervalMs: 0,
    },
  });

  process.on('SIGTERM', () => {
    void (async () => {
      await handle.stop();

      process.exit(0);
    })();
  });

  process.stdout.write(`${String(handle.listenPort)}\n`);
}

await main();
