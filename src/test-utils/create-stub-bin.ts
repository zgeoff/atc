import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a stand-in command-line tool: the script, shebang included, as an
 * executable file under the directory, which it creates when missing.
 * Returns the script's path. Writing over an existing file replaces its
 * content and makes it executable as well, so a test can swap a tool's
 * behaviour mid-run.
 */
export function createStubBin(dir: string, name: string, script: string): string {
  const path = join(dir, name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  return path;
}
