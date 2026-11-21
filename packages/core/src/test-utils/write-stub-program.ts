import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Writes a program that atc spawns, hosts or kills as itself, such as an agent CLI or an MCP
// server. The kit's createStubBin runs its script behind a wrapper, which changes the pid and the
// arguments the code under test sees.
export function writeStubProgram(directory: string, name: string, script: string): string {
  const path = join(directory, name);
  const staged = join(directory, `.${name}.${randomUUID()}`);

  mkdirSync(directory, { recursive: true });
  writeFileSync(staged, script);
  chmodSync(staged, 0o755);

  // The rename leaves a process still running the old file with it, and spares
  // the replacement the kernel's refusal to write a file that runs.
  renameSync(staged, path);

  return path;
}
