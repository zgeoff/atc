import { findClaudePermissionMode } from './find-claude-permission-mode';
import { findFlagValue } from './find-flag-value';

/**
 * The arguments that restore a Claude CLI session in its configured
 * permission mode. A resumed session otherwise takes back the mode it was
 * saved in, and only an explicit `--permission-mode` overrides that, so a
 * mode the settings alone set travels as the flag. Nothing is added when
 * the arguments already carry the flag or no mode is configured, so an
 * unconfigured session restores the mode it was saved in.
 */
export function buildRestoreModeArgs(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (findFlagValue(args, ['--permission-mode']) !== null) {
    return [];
  }

  const mode = findClaudePermissionMode([], settings);

  return mode === null ? [] : ['--permission-mode', mode];
}
