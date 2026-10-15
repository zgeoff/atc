import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a stand-in command-line tool: the script, shebang included, as an
 * executable file under the directory, which it creates when missing.
 * Returns the script's path. Writing over an existing file replaces its
 * content and makes it executable as well, so a test can swap a tool's
 * behaviour mid-run. The script lands through a rename, so a process still
 * running the old file keeps it and the replacement never meets the
 * kernel's refusal to write a file that runs.
 */
export function createStubBin(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  const staged = join(dir, `.${name}.${randomUUID()}`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(staged, script);
  chmodSync(staged, 0o755);
  renameSync(staged, path);

  return path;
}
