import { findClaudePermissionMode } from './find-claude-permission-mode';

export function resolveClaudePermissionMode(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string {
  return findClaudePermissionMode(args, settings) ?? 'auto';
}
