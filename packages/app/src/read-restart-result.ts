import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { restartsDir } from '@atc/config/config';
import { parseRestartResult } from './parse-restart-result';
import type { RestartResult } from './parse-restart-result';

/**
 * The result of the last finished restart, or null when none was written or
 * the file holds anything else.
 */
export function readRestartResult(): RestartResult | null {
  try {
    return parseRestartResult(readFileSync(join(restartsDir, 'last.json'), 'utf8').trim());
  } catch {
    return null;
  }
}
