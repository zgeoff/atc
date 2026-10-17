import type { SpawnOptions } from '@atc/plugin-api';
import { buildClaudeOverrideArgs } from './build-claude-override-args';

export interface ClaudeLaunchPaths {
  readonly leadArgs: readonly string[];

  // The session's scratch folder, or null for a launch with none.
  readonly scratch: string | null;
  readonly settings: string;
  readonly pluginDir: string;
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
    ...(opts.resume === true ? ['--resume'] : []),
    ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
    ...(opts.prompt === '' ? [] : [opts.prompt]),
  ];
}
