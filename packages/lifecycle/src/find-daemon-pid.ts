import type { DaemonPaths } from '@atc/protocol';
import { findDaemonRecord } from './find-daemon-record';
import { findPidFilePID } from './find-pid-file-pid';
import { isDaemonProcess } from './is-daemon-process';
import { isProcessAlive } from './is-process-alive';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';

// Where the daemon's files sit, and the directory read as `/proc` to check
// a pid that no socket vouches for.
interface DaemonLocation {
  readonly paths: DaemonPaths;
  readonly stateDir: string;
  readonly procRoot: string;
}

export function findDaemonPID(socketPath: string | null, location: DaemonLocation): number | null {
  const record = findDaemonRecord(location.paths.recordFile);
  const pidFilePID = findPidFilePID(location.paths.pidFile);

  const answered =
    socketPath === null
      ? null
      : pickStaleDaemonPID({
          socketPath,
          record,
          pidFileSocketPath: location.paths.socketPath,
          pidFilePID,
        });

  if (answered !== null) {
    return answered;
  }

  const candidates = [record?.pid ?? null, socketPath === null ? pidFilePID : null];

  return (
    candidates.find(
      (pid): pid is number =>
        pid !== null &&
        isProcessAlive(pid) &&
        isDaemonProcess(pid, location.stateDir, location.procRoot),
    ) ?? null
  );
}
