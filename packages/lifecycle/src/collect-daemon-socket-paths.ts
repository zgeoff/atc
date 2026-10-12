import type { DaemonPaths } from '@atc/protocol/daemon-paths';
import { findDaemonRecord } from './find-daemon-record';

/**
 * The sockets a running daemon may answer on, in the order a client tries
 * them: the one this environment computes, then the one the daemon recorded
 * in its state directory, since a client whose environment lacks
 * `XDG_RUNTIME_DIR` computes a different path from the daemon's.
 */
export function collectDaemonSocketPaths(paths: DaemonPaths): string[] {
  const record = findDaemonRecord(paths.recordFile);

  return record === null || record.socketPath === paths.socketPath
    ? [paths.socketPath]
    : [paths.socketPath, record.socketPath];
}
