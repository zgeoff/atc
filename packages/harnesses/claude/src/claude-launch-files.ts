import { writeATCBridge } from './bridge/write-atc-bridge';
import type { HookSettingsProfile } from './build-hook-settings';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { writeHookSettings } from './write-hook-settings';

// each file is written on its first use, so creating this touches no state, and once only
export class ClaudeLaunchFiles {
  private settingsFile: string | undefined;

  private bridgeDir: string | undefined;

  private readonly profile: HookSettingsProfile;

  private readonly atcArgv: readonly string[];

  private readonly options: ClaudeAdapterOptions;

  constructor(
    profile: HookSettingsProfile,
    atcArgv: readonly string[],
    options: ClaudeAdapterOptions,
  ) {
    this.profile = profile;
    this.atcArgv = atcArgv;
    this.options = options;
  }

  // The settings file's path.
  writeSettings(): string {
    this.settingsFile ??= writeHookSettings(
      this.profile,
      this.atcArgv,
      this.options.stateDir,
      this.options.homeDir,
    );

    return this.settingsFile;
  }

  // The mod's folder.
  writeBridge(): string {
    this.bridgeDir ??= writeATCBridge(this.atcArgv, this.options.bridgeTarget);

    return this.bridgeDir;
  }
}
