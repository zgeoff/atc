import { findClaudePermissionMode } from './find-claude-permission-mode';

// auto when unconfigured, since no human is at a terminal to answer a prompt
export function resolveClaudePermissionMode(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string {
  return findClaudePermissionMode(args, settings) ?? 'auto';
}
