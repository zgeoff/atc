import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '../src/protocol/protocol';
import { startLegacyDaemon } from './start-legacy-daemon';

/**
 * Runs a daemon of another protocol version as its own process, recorded in
 * the state directory the way a real daemon records itself, so a client
 * that finds it by its record can stop it. Arguments: the socket path to
 * listen on and the state directory. It refuses every handshake with
 * `protocol_mismatch`, prints `up` once it listens, and runs until it is
 * killed.
 */
function main() {
  const socketPath = process.argv.at(2);
  const stateDir = process.argv.at(3);

  if (socketPath === undefined || stateDir === undefined) {
    throw new Error('usage: run-legacy-daemon.ts <socket path> <state dir>');
  }

  startLegacyDaemon(socketPath, { protocol: PROTOCOL_V + 1 });

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

  console.log('up');
}

main();
