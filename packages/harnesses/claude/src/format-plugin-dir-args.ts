import { toShellArg } from '@atc/core';

// Each plugin folder once, in order, as a quoted --plugin-dir argument for a
// shell command line, each with a leading space.
export function formatPluginDirArgs(dirs: readonly string[]): string {
  return [...new Set(dirs)].map((dir) => ` --plugin-dir ${toShellArg(dir)}`).join('');
}
