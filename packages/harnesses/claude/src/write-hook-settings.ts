import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '@atc/config';
import { loadClaudeStatusLine } from '@atc/config/claude-statusline';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';

// the statusline takes the padding of the person's own, which atc's chains, so the two line up
export function writeHookSettings(
  profile: HookSettingsProfile,
  cliArgv: readonly string[],
  dir: string = stateDir,
  homeDir?: string,
): string {
  const file = join(dir, `hook-settings-${profile.id}.json`);
  const padding = loadClaudeStatusLine(homeDir).padding ?? 0;
  const settings = buildHookSettings(profile, padding, cliArgv);

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));

  return file;
}
