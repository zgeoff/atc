import { resolveHomeDir } from '@atc/config/host';
import { expandHome } from '@atc/core';

// The plugin folders an entry's config sets, with a leading ~ expanded to the
// daemon user's home.
export function resolveConfiguredPluginDirs(
  dirs: readonly string[] | undefined,
  homeDir: string | undefined,
): string[] {
  const home = homeDir ?? resolveHomeDir();

  return (dirs ?? []).map((dir) => expandHome(dir, home));
}
