import { writeATCBridge } from './bridge/write-atc-bridge';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import type { HookSettingsProfile } from './hooks/build-hook-settings';
import { writeHookSettings } from './hooks/write-hook-settings';

export interface ClaudeLaunchFiles {
  readonly writeSettings: () => string;

  readonly writeBridge: () => string;
}

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
