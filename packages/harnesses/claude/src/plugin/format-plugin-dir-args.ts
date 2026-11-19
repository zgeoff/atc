import { toShellArg } from '@atc/core';

export function formatPluginDirArgs(dirs: readonly string[]): string {
  return [...new Set(dirs)].map((directory) => ` --plugin-dir ${toShellArg(directory)}`).join('');
}
