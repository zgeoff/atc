import { join } from 'node:path';
import { buildMockAgentAdapter } from '@atc/test-utils';
import { startDaemon } from '../daemon';
import { startStderrLog } from '../start-stderr-log';

// It has no execution target, so it serves the protocol and spawns nothing. It prints the port it
// bound once it listens, and SIGTERM stops it.
async function main() {
  const dir = process.env['ATC_TEST_DIR'] ?? '';

  const stderrLog = await startStderrLog();

  const handle = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    targets: [],
    adapter: buildMockAgentAdapter({
      takesMessages: true,
      planHookEvents: () => ({ events: [{ kind: 'prompt-submitted' }] }),
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
      await stderrLog.stop();

      process.exit(0);
    })();
  });

  process.stdout.write(`${String(handle.listenPort)}\n`);
}

await main();
