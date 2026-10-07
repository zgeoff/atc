import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { restartsDir } from './shared/config';

/**
 * Removes the result of the last finished restart, so a reader finds a
 * result only from a restart that ran after this call.
 */
export function removeRestartResult(): void {
  rmSync(join(restartsDir, 'last.json'), { force: true });
}
