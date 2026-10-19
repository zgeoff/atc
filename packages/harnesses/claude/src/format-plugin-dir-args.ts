import { toShellArg } from '@atc/core';

export function formatPluginDirArgs(dirs: readonly string[]): string {
  return [...new Set(dirs)].map((dir) => ` --plugin-dir ${toShellArg(dir)}`).join('');
}
