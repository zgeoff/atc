import type { DaemonPaths } from '@atc/protocol';
import { findDaemonRecord } from './find-daemon-record';

// the recorded socket follows the computed one, since a client whose
// environment lacks XDG_RUNTIME_DIR computes a different path from the daemon's.
export function collectDaemonSocketPaths(paths: DaemonPaths): string[] {
  const record = findDaemonRecord(paths.recordFile);

  return record === null || record.socketPath === paths.socketPath
    ? [paths.socketPath]
    : [paths.socketPath, record.socketPath];
}
