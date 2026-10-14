import { join } from 'node:path';

/**
 * The agent entry fields that run the stand-in menu `claude` on a spec and
 * a log file: Bun as the binary, and the stand-in's script with the two
 * paths as its first arguments. A Claude launch adds its own flags after
 * them, which the stand-in ignores.
 */
export function buildStubMenuClaude(
  specPath: string,
  logPath: string,
): { readonly bin: string; readonly args: readonly string[] } {
  return {
    bin: process.execPath,
    args: [join(import.meta.dir, 'run-stub-menu-claude.ts'), specPath, logPath],
  };
}
