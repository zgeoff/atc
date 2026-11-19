import { writeFileSync } from 'node:fs';
import { buildDaemonStatePaths } from '@atc/config';
import { startStubLegacyDaemon } from '@atc/protocol/test-utils/start-stub-legacy-daemon';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { CONTRACT_MAJOR } from '@atcx/contract/light';

function main() {
  const socketPath = process.argv.at(2);
  const stateDir = process.argv.at(3);

  if (socketPath === undefined || stateDir === undefined) {
    throw new Error('usage: run-stub-legacy-daemon.ts <socket path> <state dir>');
  }

  const build = process.argv.at(4);

  startStubLegacyDaemon(socketPath, {
    protocol: build === 'current' ? PROTOCOL_V : PROTOCOL_V + 1,
    refusalHoldsProtocol: build === 'newer',
    ...(build === 'newer' || build === 'current'
      ? { major: build === 'newer' ? CONTRACT_MAJOR + 1 : CONTRACT_MAJOR }
      : {}),
    replies: { 'session.list': { sessions: [] }, 'fleet.list': { fleet: [] } },
    owner: 'caller',
  });

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
    buildDaemonStatePaths(stateDir).recordFile,
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
