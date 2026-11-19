import { findFlagValue } from '@atc/plugin-api';
import { findClaudePermissionMode } from '../screen/find-claude-permission-mode';

// A resumed session restores its saved mode; only an explicit --permission-mode flag
// overrides it, so a mode set only in settings must be passed as the flag.
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
