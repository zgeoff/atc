import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { collectDaemonSocketPaths } from './collect-daemon-socket-paths';
import type { LifecycleHost } from './lifecycle-host';
import { tryOpenDaemon } from './try-open-daemon';

// How long the handshake may take.
const PROBE_DEADLINE_MS = 3000;

/**
 * Prints the running daemon's `daemonID`, the identity a gateway registry
 * pins, read from the handshake over the owner's local socket: the one this
 * environment computes, else the one the daemon recorded in the state
 * directory. When no daemon answers with one, prints a hint to stderr and
 * exits nonzero instead of booting one.
 */
export async function runDaemonID(host: LifecycleHost): Promise<void> {
  const paths = buildHostDaemonPaths(host);

  const probe = await tryOpenDaemon(
    collectDaemonSocketPaths(paths),
    {
      build: host.invocation.readBuild(),
      deadline: host.clock.now() + PROBE_DEADLINE_MS,
      clock: host.clock,
    },
    () => Promise.resolve(null),
  );

  if (probe?.kind === 'ok' && probe.hello.daemonID !== null) {
    console.log(probe.hello.daemonID);

    return;
  }

  console.error(`atc daemon id: no daemon at ${paths.socketPath} — start one first`);
  process.exit(1);
}
