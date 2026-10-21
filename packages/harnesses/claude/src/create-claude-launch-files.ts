import { writeATCBridge } from './bridge/write-atc-bridge';
import type { HookSettingsProfile } from './build-hook-settings';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { writeHookSettings } from './write-hook-settings';

export interface ClaudeLaunchFiles {
  // The settings file's path.
  readonly writeSettings: () => string;

  // The mod's folder.
  readonly writeBridge: () => string;
}

// each file is written on its first use, so creating this touches no state, and once only
export function createClaudeLaunchFiles(
  profile: HookSettingsProfile,
  atcArgv: readonly string[],
  options: ClaudeAdapterOptions,
): ClaudeLaunchFiles {
  let settingsFile: string | undefined;
  let bridgeDir: string | undefined;

  return {
    writeSettings: () => {
      settingsFile ??= writeHookSettings(profile, atcArgv, options.stateDir, options.homeDir);

      return settingsFile;
    },

    writeBridge: () => {
      bridgeDir ??= writeATCBridge(atcArgv, options.bridgeTarget);

      return bridgeDir;
    },
  };
}
