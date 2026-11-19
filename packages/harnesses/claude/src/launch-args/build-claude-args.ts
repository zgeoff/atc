import type { SpawnOptions } from '@atc/plugin-api';
import { buildClaudeOverrideArgs } from './build-claude-override-args';

export interface ClaudeLaunchPaths {
  readonly leadArgs: readonly string[];

  readonly scratch: string | null;
  readonly settings: string;
  readonly pluginDir: string;

  readonly pluginDirs: readonly string[];
}

export function buildClaudeArgs(
  configured: readonly string[],
  opts: SpawnOptions,
  paths: ClaudeLaunchPaths,
): string[] {
  // --add-dir and --plugin-dir are variadic and would take the prompt as a value, so the
  // settings flag sits after them and the prompt comes last.
  return [
    ...buildClaudeOverrideArgs(configured, opts),
    ...paths.leadArgs,
    ...(paths.scratch === null ? [] : ['--add-dir', paths.scratch]),
    '--settings',
    paths.settings,
    '--plugin-dir',
    paths.pluginDir,
    ...[...new Set(paths.pluginDirs)].flatMap((directory) => ['--plugin-dir', directory]),
    ...(opts.resume === true ? ['--resume'] : []),
    ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
    ...(opts.prompt === '' ? [] : [opts.prompt]),
  ];
}
