import type { DaemonPaths } from '@atc/protocol';
import { readDaemonRecord } from './read-daemon-record';

// the recorded socket follows the computed one, since a client whose
// environment lacks XDG_RUNTIME_DIR computes a different path from the daemon's.
export function readDaemonSocketPaths(paths: DaemonPaths): string[] {
  const record = readDaemonRecord(paths.recordFile);

  return record === null || record.socketPath === paths.socketPath
    ? [paths.socketPath]
    : [paths.socketPath, record.socketPath];
}
