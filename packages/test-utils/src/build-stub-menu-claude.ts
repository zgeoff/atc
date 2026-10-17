import { join } from 'node:path';

export function buildStubMenuClaude(
  specPath: string,
  logPath: string,
): { readonly bin: string; readonly args: readonly string[] } {
  return {
    bin: process.execPath,

    // A Claude launch appends its own flags after these, which the stand-in ignores.
    args: [join(import.meta.dir, 'run-stub-menu-claude.ts'), specPath, logPath],
  };
}
