import { homedir } from 'node:os';

/**
 * The user's home directory: `$HOME` when it is set, which is how Node's
 * `os.homedir()` resolves it, otherwise the account's home. Bun's
 * `os.homedir()` reads `$HOME` once at startup, so this reads it on every
 * call, and a test preload that points `$HOME` at a temp directory moves
 * every path derived from it.
 */
export function resolveHomeDir(): string {
  const home = process.env['HOME'];

  return home !== undefined && home !== '' ? home : homedir();
}
