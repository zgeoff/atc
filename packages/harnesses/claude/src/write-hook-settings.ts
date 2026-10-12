import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '@atc/config/config';
import { loadClaudeStatusLine } from '@atc/config/load-claude-statusline';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';

/**
 * Writes the settings file passed to a wrangled session as
 * `claude --settings`, one per agent id, into the folder `dir`, and returns
 * its path. Its hooks run the atc CLI that `cliArgv` runs. Its statusline
 * takes the padding of the person's own statusline, from the Claude config
 * folder of the home `homeDir`, which atc's statusline chains, so the two
 * line up.
 */
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
