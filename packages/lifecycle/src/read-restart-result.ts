import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRestartResult } from './parse-restart-result';
import type { RestartResult } from './parse-restart-result';

export function readRestartResult(restartsDir: string): RestartResult | null {
  try {
    return parseRestartResult(readFileSync(join(restartsDir, 'last.json'), 'utf8').trim());
  } catch {
    return null;
  }
}
