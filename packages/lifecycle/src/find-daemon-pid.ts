import type { DaemonPaths } from '@atc/protocol/daemon-paths';
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

/**
 * The pid of the daemon to stop. `socketPath` is the socket whose daemon
 * answered or refused the handshake, or null when none did. A daemon that
 * answered is identified by the source that belongs to its socket: the
 * state directory's record when it lists that socket, else the pid file
 * beside it. Without such a source, the recorded pid counts, and with no
 * answer at all the pid file's pid counts too, but only while that pid runs
 * `atc daemon` on this state directory, since a recorded pid may have been
 * reused by an unrelated process since the daemon died. Null when none
 * does.
 */
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
