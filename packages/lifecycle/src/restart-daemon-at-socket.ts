import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { findDaemonPID } from './find-daemon-pid';
import { findRestartUnit } from './find-restart-unit';
import type { LifecycleHost } from './lifecycle-host';
import { restartDaemonProcess } from './restart-daemon-process';

/**
 * Takes the daemon behind `socketPath`, the socket it answered a handshake
 * on, out of service for a client that boots its replacement: the user
 * service that runs it restarts, or the daemon stops. Resolves false,
 * touching nothing, when no pid for that daemon is found.
 */
export async function restartDaemonAtSocket(
  host: LifecycleHost,
  socketPath: string,
): Promise<boolean> {
  const pid = findDaemonPID(socketPath, {
    paths: buildHostDaemonPaths(host),
    stateDir: host.paths.stateDir,
    procRoot: host.procRoot,
  });

  if (pid === null) {
    return false;
  }

  const unit = await findRestartUnit(pid, host);

  await restartDaemonProcess({ pid, unit }, host);

  return true;
}
