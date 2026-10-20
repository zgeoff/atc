import type { DaemonPaths } from '@atc/protocol';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';
import { probeDaemonProcess } from './probe-daemon-process';
import { probeProcessAlive } from './probe-process-alive';
import { readDaemonRecord } from './read-daemon-record';
import { readPidFilePID } from './read-pid-file-pid';

// Where the daemon's files sit, and the directory read as `/proc` to check
// a pid that no socket vouches for.
interface DaemonLocation {
  readonly paths: DaemonPaths;
  readonly stateDir: string;
  readonly procRoot: string;
}

export function readDaemonPID(socketPath: string | null, location: DaemonLocation): number | null {
  const record = readDaemonRecord(location.paths.recordFile);
  const pidFilePID = readPidFilePID(location.paths.pidFile);

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
        probeProcessAlive(pid) &&
        probeDaemonProcess(pid, location.stateDir, location.procRoot),
    ) ?? null
  );
}
