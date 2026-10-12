import { renameSync, writeFileSync } from 'node:fs';
import type { DaemonRecord } from '../shared/find-daemon-record';

/**
 * Writes the running daemon's record through a temporary file and a
 * rename, so a reader never sees half of it.
 */
export function writeDaemonRecord(recordPath: string, record: DaemonRecord): void {
  const tmpPath = `${recordPath}.${process.pid}.tmp`;

  writeFileSync(tmpPath, `${JSON.stringify(record)}\n`);
  renameSync(tmpPath, recordPath);
}
