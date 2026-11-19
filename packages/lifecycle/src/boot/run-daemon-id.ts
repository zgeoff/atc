import { buildHostDaemonPaths } from '../daemon-files/build-host-daemon-paths';
import { readDaemonSocketPaths } from '../daemon-files/read-daemon-socket-paths';
import { tryOpenDaemon } from './try-open-daemon';
import type { LifecycleHost } from './types';

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
