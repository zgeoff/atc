import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RestartResult } from '@atcx/contract';

export function writeRestartResult(restartsDir: string, result: RestartResult): void {
  mkdirSync(restartsDir, { recursive: true });

  const staging = join(restartsDir, `last.${process.pid}.tmp`);

  writeFileSync(staging, `${JSON.stringify(result)}\n`);
  renameSync(staging, join(restartsDir, 'last.json'));
}
