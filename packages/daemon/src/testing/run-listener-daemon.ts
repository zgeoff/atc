import { join } from 'node:path';
import { systemClock } from '@atc/core';
import { buildMockAgentAdapter } from '@atc/test-utils';
import { startDaemon } from '../daemon';
import { startStderrLog } from '../start-stderr-log';

const STDERR_FD = 2;

// The log's batch, so a flood of a hundred refusals fills what the log holds and drops the rest:
// each refusal costs a loopback connection, and on a small host a flood of thousands can wait
// seconds on a retried SYN.
const LOG_BATCH_LINES = 16;

// It has no execution target, so it serves the protocol and spawns nothing. It prints the port it
// bound once it listens, and SIGTERM stops it.
async function main() {
  const directory = process.env['ATC_TEST_DIR'] ?? '';

  const stderrLog = await startStderrLog(STDERR_FD, systemClock, LOG_BATCH_LINES);

  const handle = await startDaemon({
    socketPath: join(directory, 'daemon.sock'),
    reporterSocketPath: join(directory, 'reporter.sock'),
    build: 'atc/test-build',
    targets: [],
    adapter: buildMockAgentAdapter({
      takesMessages: true,
      planHookEvents: () => ({ events: [{ kind: 'prompt-submitted' }] }),
      planResumeCommand: () => 'claude --resume',
    }),
    dbPath: join(directory, 'state.db'),
    statusPath: join(directory, 'status.json'),
    listen: {
      host: '127.0.0.1',
      port: 0,
      tokenFile: join(directory, 'gateway-token'),
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
