import { findClaudePermissionMode } from './find-claude-permission-mode';

/**
 * The permission mode a Claude CLI agent's headless turns run in: the mode
 * its configuration sets, else auto, since no human is at a terminal to
 * answer a prompt.
 */
export function resolveClaudePermissionMode(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string {
  return findClaudePermissionMode(args, settings) ?? 'auto';
}
