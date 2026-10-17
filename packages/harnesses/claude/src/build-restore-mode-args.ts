import { findFlagValue } from '@atc/plugin-api';
import { findClaudePermissionMode } from './find-claude-permission-mode';

// a resumed session takes back the mode it was saved in, which only an explicit
// `--permission-mode` overrides, so a mode the settings alone set travels as the flag
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
