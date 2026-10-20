import { buildHostDaemonPaths } from './build-host-daemon-paths';
import type { LifecycleHost } from './lifecycle-host';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';
import { tryOpenDaemon } from './try-open-daemon';

// How long the handshake may take.
const PROBE_DEADLINE_MS = 3000;

export async function runDaemonID(host: LifecycleHost): Promise<void> {
  const paths = buildHostDaemonPaths(host);

  const probe = await tryOpenDaemon(
    readDaemonSocketPaths(paths),
    {
      build: host.invocation.readBuild(),
      deadline: host.clock.now() + PROBE_DEADLINE_MS,
      clock: host.clock,
    },
    () => Promise.resolve(null),
  );

  if (probe?.kind === 'ok') {
    console.log(probe.hello.daemonID);

    return;
  }

  console.error(`atc daemon id: no daemon at ${paths.socketPath} — start one first`);
  process.exit(1);
}
