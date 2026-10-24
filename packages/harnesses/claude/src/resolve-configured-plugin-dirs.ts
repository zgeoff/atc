import { normalizePluginDir } from '@atc/plugin-api';
import { resolveHomeDir } from '@atcx/contract/light';

export function resolveConfiguredPluginDirs(
  dirs: readonly string[] | undefined,
  homeDir: string | undefined,
): string[] {
  const home = homeDir ?? resolveHomeDir();

  return (dirs ?? []).map((directory) => normalizePluginDir(directory, home));
}
