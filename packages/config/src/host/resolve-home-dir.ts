import { homedir } from 'node:os';

// Bun's `os.homedir()` reads `$HOME` once at startup, so the environment is
// read on every call, and a test preload that moves `$HOME` moves every path.
export function resolveHomeDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env['HOME'];

  return home !== undefined && home !== '' ? home : homedir();
}
