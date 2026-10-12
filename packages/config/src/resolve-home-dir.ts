import { homedir } from 'node:os';

/**
 * The user's home directory: `HOME` in the environment when it is set,
 * which is how Node's `os.homedir()` resolves it, otherwise the account's
 * home. Bun's `os.homedir()` reads `$HOME` once at startup, so this reads
 * the environment it is given on every call, and a test preload that points
 * `$HOME` at a temp directory moves every path derived from it.
 */
export function resolveHomeDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env['HOME'];

  return home !== undefined && home !== '' ? home : homedir();
}
