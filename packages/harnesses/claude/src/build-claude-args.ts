import type { SpawnOptions } from '@atc/plugin-api';
import { buildClaudeOverrideArgs } from './build-claude-override-args';

/**
 * Where one Claude launch finds its files, and the arguments that go ahead
 * of them: a permission mode or an MCP config.
 */
export interface ClaudeLaunchPaths {
  readonly leadArgs: readonly string[];

  // The session's scratch folder, or null for a launch with none.
  readonly scratch: string | null;
  readonly settings: string;
  readonly pluginDir: string;
}

/**
 * The arguments a Claude CLI launch runs with: the configured arguments
 * with the spawn's own model and effort, the lead arguments, the scratch
 * folder as a working directory of the session's own, so the CLI reads and
 * writes there without a prompt, the settings file and the mod folder, the
 * resume, and the prompt. The variadic flags sit ahead of the settings
 * flag, so neither takes the prompt as one of its values.
 */
export function buildClaudeArgs(
  configured: readonly string[],
  opts: SpawnOptions,
  paths: ClaudeLaunchPaths,
): string[] {
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
