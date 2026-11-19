import { renameSync, writeFileSync } from 'node:fs';
import type { DaemonRecord } from './read-daemon-record';

export function writeDaemonRecord(recordPath: string, record: DaemonRecord): void {
  const tmpPath = `${recordPath}.${process.pid}.tmp`;

  writeFileSync(tmpPath, `${JSON.stringify(record)}\n`);
  renameSync(tmpPath, recordPath);
}
