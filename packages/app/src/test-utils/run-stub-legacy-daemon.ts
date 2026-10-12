import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '../protocol/protocol';
import { startStubLegacyDaemon } from './start-stub-legacy-daemon';

/**
 * Runs a daemon of another protocol version as its own process, recorded in
 * the state directory the way a real daemon records itself, so a client
 * that finds it by its record can stop it. Arguments: the socket path to
 * listen on and the state directory. It refuses every handshake with
 * `protocol_mismatch` and hosts one session, a child process that sleeps for
 * a minute. Once it listens it prints `up` and the session's pid on one
 * line, and it runs until it is killed. On SIGTERM or SIGINT it kills and
 * reaps the session, then dies of the same signal, and it kills the session
 * whenever it exits, so a caller that stops only the daemon leaves nothing
 * behind.
 */
function main() {
  const socketPath = process.argv.at(2);
  const stateDir = process.argv.at(3);

  if (socketPath === undefined || stateDir === undefined) {
    throw new Error('usage: run-stub-legacy-daemon.ts <socket path> <state dir>');
  }

  startStubLegacyDaemon(socketPath, { protocol: PROTOCOL_V + 1, owner: 'caller' });

  const session = Bun.spawn(['sleep', '60']);

  process.on('exit', () => {
    session.kill('SIGKILL');
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        session.kill('SIGKILL');

        await session.exited;

        process.kill(process.pid, signal);
      })();
    });
  }

  writeFileSync(
    join(stateDir, 'daemon.json'),
    JSON.stringify({
      pid: process.pid,
      socketPath,
      reporterSocketPath: `${socketPath}.reporter`,
      eventsSocketPath: null,
      listenPort: null,
    }),
  );

  console.log(`up ${session.pid}`);
}

main();
