import { join } from 'node:path';

export function buildHookSettingsPath(directory: string, profileID: string): string {
  return join(directory, `hook-settings-${profileID}.json`);
}
