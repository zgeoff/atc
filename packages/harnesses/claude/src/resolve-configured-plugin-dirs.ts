import { resolveHomeDir } from '@atc/config/host';
import { expandHome } from '@atc/core';

export function resolveConfiguredPluginDirs(
  dirs: readonly string[] | undefined,
  homeDir: string | undefined,
): string[] {
  const home = homeDir ?? resolveHomeDir();

  return (dirs ?? []).map((dir) => expandHome(dir, home));
}
