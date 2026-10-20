import { resolveHomeDir } from '@atc/config/host';
import { normalizePluginDir } from '@atc/plugin-api';

export function resolveConfiguredPluginDirs(
  dirs: readonly string[] | undefined,
  homeDir: string | undefined,
): string[] {
  const home = homeDir ?? resolveHomeDir();

  return (dirs ?? []).map((directory) => normalizePluginDir(directory, home));
}
