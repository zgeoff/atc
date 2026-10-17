import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createStubBin(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  const staged = join(dir, `.${name}.${randomUUID()}`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(staged, script);
  chmodSync(staged, 0o755);

  // The rename leaves a process still running the old file with it, and spares
  // the replacement the kernel's refusal to write a file that runs.
  renameSync(staged, path);

  return path;
}
