import type { SpawnOptions } from '@atc/plugin-api';
import { buildClaudeOverrideArgs } from './build-claude-override-args';

export interface ClaudeLaunchPaths {
  readonly leadArgs: readonly string[];

  // The session's scratch folder, or null for a launch with none.
  readonly scratch: string | null;
  readonly settings: string;
  readonly pluginDir: string;

  // The plugin folders the launch loads beside atc's own, the config's first
  // and then the session's.
  readonly pluginDirs: readonly string[];
}

export function buildClaudeArgs(
  configured: readonly string[],
  opts: SpawnOptions,
  paths: ClaudeLaunchPaths,
): string[] {
  // the scratch folder is a working directory, so the CLI reads and writes it without a prompt;
  // the variadic flags sit ahead of the settings flag, so neither takes the prompt as a value
  return [
    ...buildClaudeOverrideArgs(configured, opts),
    ...paths.leadArgs,
    ...(paths.scratch === null ? [] : ['--add-dir', paths.scratch]),
    '--settings',
    paths.settings,
    '--plugin-dir',
    paths.pluginDir,
    ...[...new Set(paths.pluginDirs)].flatMap((dir) => ['--plugin-dir', dir]),
    ...(opts.resume === true ? ['--resume'] : []),
    ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
    ...(opts.prompt === '' ? [] : [opts.prompt]),
  ];
}
