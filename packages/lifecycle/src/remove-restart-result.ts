import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Removes the result of the last finished restart from the restarts
 * directory, so a reader finds a result only from a restart that ran after
 * this call.
 */
export function removeRestartResult(restartsDir: string): void {
  rmSync(join(restartsDir, 'last.json'), { force: true });
}
