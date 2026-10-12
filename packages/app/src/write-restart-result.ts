import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RestartResult } from './parse-restart-result';
import { restartsDir } from './shared/config';

/**
 * Writes the result of a finished restart to `last.json` in the restarts
 * directory, through a rename so a reader never sees half a record.
 */
export function writeRestartResult(result: RestartResult): void {
  mkdirSync(restartsDir, { recursive: true });

  const staging = join(restartsDir, `last.${process.pid}.tmp`);

  writeFileSync(staging, `${JSON.stringify(result)}\n`);
  renameSync(staging, join(restartsDir, 'last.json'));
}
