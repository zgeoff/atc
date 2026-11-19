import { mkdirSync, writeFileSync } from 'node:fs';
import { stateDir } from '@atc/config';
import { loadClaudeStatusLine } from '@atc/config/claude-statusline';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';
import { buildHookSettingsPath } from './build-hook-settings-path';

// the statusline takes the padding of the person's own, which atc's chains, so the two line up
export function writeHookSettings(
  profile: HookSettingsProfile,
  cliArgv: readonly string[],
  directory: string = stateDir,
  homeDir?: string,
): string {
  const file = buildHookSettingsPath(directory, profile.id);
  const padding = loadClaudeStatusLine(homeDir).padding ?? 0;
  const settings = buildHookSettings(profile, padding, cliArgv);

  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));

  return file;
}
