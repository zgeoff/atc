import { rmSync } from 'node:fs';
import { join } from 'node:path';

export function removeRestartResult(restartsDir: string): void {
  rmSync(join(restartsDir, 'last.json'), { force: true });
}
