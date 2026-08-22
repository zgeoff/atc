import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';
import { stateDir } from './config';
import { isRecord } from './report';

/**
 * Writes the settings file passed to a wrangled session as
 * `claude --settings`, one per agent id, and returns its path.
 */
export function writeHookSettings(profile: HookSettingsProfile): string {
  const file = join(stateDir, `hook-settings-${profile.id}.json`);
  const settings = buildHookSettings(profile, readStatuslinePadding());

  writeFileSync(file, JSON.stringify(settings, null, 2));

  return file;
}

/**
 * The padding on the user's own statusline, so the chained one lines up with
 * it. An unreadable or unconfigured setting is no padding.
 */
function readStatuslinePadding(): number {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const user: unknown = JSON.parse(raw);
    const statusLine = isRecord(user) ? user['statusLine'] : undefined;
    const padding = isRecord(statusLine) ? statusLine['padding'] : undefined;

    return typeof padding === 'number' ? padding : 0;
  } catch {
    return 0;
  }
}
