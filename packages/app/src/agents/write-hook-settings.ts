import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../shared/config';
import { isRecord } from '../shared/report';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';

/**
 * Writes the settings file passed to a wrangled session as
 * `claude --settings`, one per agent id, into the folder `dir`, and returns
 * its path. The statusline padding comes from the Claude settings in the
 * user's home `homeDir`.
 */
export function writeHookSettings(
  profile: HookSettingsProfile,
  dir: string = stateDir,
  homeDir: string = resolveHomeDir(),
): string {
  const file = join(dir, `hook-settings-${profile.id}.json`);
  const settings = buildHookSettings(profile, readStatuslinePadding(homeDir));

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));

  return file;
}

/**
 * The padding on the user's own statusline, so the chained one lines up with
 * it. An unreadable or unconfigured setting is no padding.
 */
function readStatuslinePadding(homeDir: string): number {
  try {
    const raw = readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8');
    const user: unknown = JSON.parse(raw);
    const statusLine = isRecord(user) ? user['statusLine'] : undefined;
    const padding = isRecord(statusLine) ? statusLine['padding'] : undefined;

    return typeof padding === 'number' ? padding : 0;
  } catch {
    return 0;
  }
}
