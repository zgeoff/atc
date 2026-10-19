import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { startStubLegacyDaemon } from './start-stub-legacy-daemon';
import { startStubLineDaemon } from './start-stub-line-daemon';

function main() {
  const socketPath = process.argv.at(2);
  const stateDir = process.argv.at(3);

  if (socketPath === undefined || stateDir === undefined) {
    throw new Error('usage: run-stub-legacy-daemon.ts <socket path> <state dir>');
  }

  const build = process.argv.at(4);

  // A client on the current protocol reads the session list and the fleet
  // as it starts, so the daemon answers both as empty. With 'line' it is a
  // release that speaks the line protocol.
  if (build === 'line') {
    startStubLineDaemon(socketPath, { owner: 'caller' });
  } else {
    startStubLegacyDaemon(socketPath, {
      protocol: build === 'current' ? PROTOCOL_V : PROTOCOL_V + 1,
      replies: { 'session.list': { sessions: [] }, 'fleet.list': { fleet: [] } },
      owner: 'caller',
    });
  }

  const session = Bun.spawn(['sleep', '60']);

  // Killing the session on every exit means a caller that stops only the daemon
  // leaves nothing behind.
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

  // Recorded the way a real daemon records itself, so a client that finds it by
  // its record can stop it.
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
