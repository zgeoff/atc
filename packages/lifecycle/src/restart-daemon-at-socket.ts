import { buildHostDaemonPaths } from './build-host-daemon-paths';
import type { LifecycleHost } from './lifecycle-host';
import { readDaemonPID } from './read-daemon-pid';
import { readRestartUnit } from './read-restart-unit';
import { restartDaemonProcess } from './restart-daemon-process';

export async function restartDaemonAtSocket(
  host: LifecycleHost,
  socketPath: string,
): Promise<boolean> {
  const pid = readDaemonPID(socketPath, {
    paths: buildHostDaemonPaths(host),
    stateDir: host.paths.stateDir,
    procRoot: host.procRoot,
  });

  if (pid === null) {
    return false;
  }

  const unit = await readRestartUnit(pid, host);

  await restartDaemonProcess({ pid, unit }, host);

  return true;
}
